import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey, type KeyInput } from "jose"

export interface AccessClaims {
  readonly subject: string
  readonly commonName?: string
  readonly email?: string
  readonly audience: readonly string[]
}

export interface AccessVerificationConfiguration {
  readonly accessIssuer: string
  readonly accessAudience: string
}

export interface CoreAccessConfiguration extends AccessVerificationConfiguration {
  readonly ingressSecret: string
  readonly egressSecret: string
  readonly agentSubject: string
}

export interface SetupAccessConfiguration extends AccessVerificationConfiguration {
  readonly ownerEmail: string
}

export type CoreCaller = "ingress" | "egress" | "agent"

export type AccessTokenVerifier = (
  request: Request,
  configuration: AccessVerificationConfiguration
) => Promise<AccessClaims>

async function secretMatches(supplied: string | null, expected: string): Promise<boolean> {
  if (supplied === null) return false
  const encoder = new TextEncoder()
  const [left, right] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(supplied)),
    crypto.subtle.digest("SHA-256", encoder.encode(expected))
  ])
  const leftBytes = new Uint8Array(left)
  const rightBytes = new Uint8Array(right)
  let difference = 0
  for (let index = 0; index < leftBytes.length; index += 1) {
    difference |= leftBytes[index]! ^ rightBytes[index]!
  }
  return difference === 0
}

const keySets = new Map<string, ReturnType<typeof createRemoteJWKSet>>()

export async function verifyCloudflareAccessAssertion(
  assertion: string,
  configuration: AccessVerificationConfiguration,
  key: KeyInput | JWTVerifyGetKey
): Promise<AccessClaims> {
  const verified = await jwtVerify(assertion, key, {
    audience: configuration.accessAudience,
    issuer: configuration.accessIssuer,
    clockTolerance: 5
  })
  const audience = Array.isArray(verified.payload.aud)
    ? verified.payload.aud
    : verified.payload.aud === undefined
      ? []
      : [verified.payload.aud]
  return {
    subject: typeof verified.payload.sub === "string" ? verified.payload.sub : "",
    ...(typeof verified.payload.common_name === "string"
      ? { commonName: verified.payload.common_name }
      : {}),
    ...(typeof verified.payload.email === "string" ? { email: verified.payload.email } : {}),
    audience
  }
}

export const verifyCloudflareAccess: AccessTokenVerifier = async (request, configuration) => {
  const assertion = request.headers.get("cf-access-jwt-assertion")
  if (assertion === null || assertion.length > 16_384) throw new Error("access_denied")
  let keys = keySets.get(configuration.accessIssuer)
  if (keys === undefined) {
    keys = createRemoteJWKSet(new URL(`${configuration.accessIssuer}/cdn-cgi/access/certs`), {
      timeoutDuration: 10_000
    })
    keySets.set(configuration.accessIssuer, keys)
  }
  return verifyCloudflareAccessAssertion(assertion, configuration, keys)
}

function requiredCaller(pathname: string): CoreCaller | undefined {
  if (
    pathname === "/internal/inbound" ||
    pathname === "/internal/status" ||
    /^\/internal\/inbound\/[^/]+\/enqueued$/.test(pathname)
  ) {
    return "ingress"
  }
  if (/^\/internal\/outbox\/[^/]+\/(?:claim|result)$/.test(pathname)) return "egress"
  if (pathname === "/internal/tools" || pathname === "/internal/agent/result") return "agent"
  return undefined
}

export async function authorizeCoreRequest(
  request: Request,
  configuration: CoreAccessConfiguration,
  verifyAccess: AccessTokenVerifier = verifyCloudflareAccess
): Promise<CoreCaller> {
  const caller = requiredCaller(new URL(request.url).pathname)
  if (caller === undefined) throw new Error("access_denied")
  if (caller === "ingress" || caller === "egress") {
    const expected = caller === "ingress" ? configuration.ingressSecret : configuration.egressSecret
    if (!(await secretMatches(request.headers.get("x-bob-caller-token"), expected))) {
      throw new Error("access_denied")
    }
    return caller
  }
  const claims = await verifyAccess(request, configuration)
  if (!claims.audience.includes(configuration.accessAudience)) throw new Error("access_denied")
  if (
    caller === "agent" &&
    claims.email === undefined &&
    claims.subject === "" &&
    claims.commonName === configuration.agentSubject
  ) {
    return caller
  }
  throw new Error("access_denied")
}

export async function authorizeSetupRequest(
  request: Request,
  configuration: SetupAccessConfiguration,
  verifyAccess: AccessTokenVerifier = verifyCloudflareAccess
): Promise<void> {
  const claims = await verifyAccess(request, configuration)
  if (!claims.audience.includes(configuration.accessAudience)) throw new Error("access_denied")
  if (
    claims.subject.length === 0 ||
    claims.email?.toLowerCase() !== configuration.ownerEmail.toLowerCase()
  ) {
    throw new Error("access_denied")
  }
}
