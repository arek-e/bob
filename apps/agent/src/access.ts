import { Context, Layer } from "effect"
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey, type KeyInput } from "jose"

export interface AccessIdentity {
  readonly subject: string
  readonly commonName: string
  readonly scope: AccessScope
}

export type AccessScope = "run" | "admin"

export interface AccessVerifier {
  verify(request: Request, scope: AccessScope): Promise<AccessIdentity>
}

export const AccessVerifier = Context.Service<AccessVerifier>("bob/AccessVerifier")

export async function verifyServiceTokenAssertion(
  assertion: string,
  key: KeyInput | JWTVerifyGetKey,
  policy: {
    readonly issuer: string
    readonly audience: string
    readonly clientId: string
    readonly scope: AccessScope
  }
): Promise<AccessIdentity> {
  const result = await jwtVerify(assertion, key, {
    audience: policy.audience,
    issuer: policy.issuer,
    clockTolerance: 5
  })
  if (
    result.payload.sub !== "" ||
    typeof result.payload.common_name !== "string" ||
    result.payload.common_name !== policy.clientId ||
    result.payload.email !== undefined
  ) {
    throw new Error("access_denied")
  }
  return {
    subject: "",
    commonName: result.payload.common_name,
    scope: policy.scope
  }
}

export function createAccessVerifier(options: {
  readonly teamDomain: string
  readonly runAudience: string
  readonly runSubject: string
  readonly adminAudience: string
  readonly adminSubject: string
}): AccessVerifier {
  const issuer = `https://${options.teamDomain}`
  const keys = createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`), {
    timeoutDuration: 10_000
  })
  return {
    async verify(request, scope) {
      const assertion = request.headers.get("cf-access-jwt-assertion")
      if (assertion === null || assertion.length > 16_384) throw new Error("access_denied")
      const policy =
        scope === "run"
          ? { audience: options.runAudience, clientId: options.runSubject }
          : { audience: options.adminAudience, clientId: options.adminSubject }
      return verifyServiceTokenAssertion(assertion, keys, { issuer, ...policy, scope })
    }
  }
}

export function accessVerifierLayer(service: AccessVerifier) {
  return Layer.succeed(AccessVerifier, service)
}
