export type CoreCaller = "ingress" | "egress" | "agent"

export interface CoreAccessConfiguration {
  readonly ingressSecret: string
  readonly egressSecret: string
  readonly agentSecret: string
}

export interface SetupAccessConfiguration {
  readonly setupToken: string
}

async function secretMatches(supplied: string | null, expected: string): Promise<boolean> {
  if (supplied === null) return false
  const encoder = new TextEncoder()
  const [suppliedHash, expectedHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(supplied)),
    crypto.subtle.digest("SHA-256", encoder.encode(expected))
  ])
  const suppliedBytes = new Uint8Array(suppliedHash)
  const expectedBytes = new Uint8Array(expectedHash)
  let difference = suppliedBytes.byteLength ^ expectedBytes.byteLength
  for (let index = 0; index < Math.min(suppliedBytes.length, expectedBytes.length); index += 1) {
    difference |= suppliedBytes[index]! ^ expectedBytes[index]!
  }
  return difference === 0
}

function requiredCaller(pathname: string): CoreCaller | undefined {
  if (
    pathname === "/internal/inbound" ||
    pathname === "/internal/status" ||
    /^\/internal\/inbound\/[^/]+\/enqueued$/.test(pathname) ||
    /^\/internal\/inbound\/[^/]+\/attachments\/\d+$/.test(pathname)
  ) {
    return "ingress"
  }
  if (/^\/internal\/outbox\/[^/]+\/(?:claim|result)$/.test(pathname)) return "egress"
  if (
    pathname === "/internal/tools" ||
    pathname === "/internal/agent/result" ||
    pathname === "/internal/agent/operations" ||
    pathname === "/internal/agent/operations/load" ||
    pathname === "/internal/readiness" ||
    /^\/internal\/agent\/runs\/[^/]+\/attachments\/[^/]+$/.test(pathname)
  ) {
    return "agent"
  }
  return undefined
}

export async function authorizeCoreRequest(
  request: Request,
  configuration: CoreAccessConfiguration
): Promise<CoreCaller> {
  const caller = requiredCaller(new URL(request.url).pathname)
  if (caller === undefined) throw new Error("access_denied")
  const expected =
    caller === "ingress"
      ? configuration.ingressSecret
      : caller === "egress"
        ? configuration.egressSecret
        : configuration.agentSecret
  if (!(await secretMatches(request.headers.get("x-bob-caller-token"), expected))) {
    throw new Error("access_denied")
  }
  return caller
}

export async function authorizeSetupRequest(
  request: Request,
  configuration: SetupAccessConfiguration
): Promise<void> {
  if (!(await secretMatches(request.headers.get("x-bob-setup-token"), configuration.setupToken))) {
    throw new Error("access_denied")
  }
}
