import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey, type KeyInput } from "jose"

export interface InstanceIdentity {
  readonly instanceId: string
}

export interface InstanceAuthenticator {
  authenticate(request: Request): Promise<InstanceIdentity>
}

export async function verifyInstanceAssertion(
  assertion: string,
  key: KeyInput | JWTVerifyGetKey,
  policy: { readonly issuer: string; readonly audience: string }
): Promise<string> {
  const result = await jwtVerify(assertion, key, {
    audience: policy.audience,
    issuer: policy.issuer,
    clockTolerance: 5
  })
  if (
    result.payload.sub !== "" ||
    typeof result.payload.common_name !== "string" ||
    result.payload.common_name.length === 0 ||
    result.payload.email !== undefined
  ) {
    throw new Error("access_denied")
  }
  return result.payload.common_name
}

export function createInstanceAuthenticator(options: {
  readonly database: D1Database
  readonly teamDomain: string
  readonly audience: string
}): InstanceAuthenticator {
  const issuer = `https://${options.teamDomain}`
  const keys = createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`), {
    timeoutDuration: 10_000
  })
  return {
    async authenticate(request) {
      const assertion = request.headers.get("cf-access-jwt-assertion")
      if (assertion === null || assertion.length > 16_384) throw new Error("access_denied")
      const commonName = await verifyInstanceAssertion(assertion, keys, {
        issuer,
        audience: options.audience
      })
      const caller = await options.database
        .prepare(
          "SELECT instance_id FROM connection_gateway_callers WHERE common_name = ? AND revoked_at IS NULL"
        )
        .bind(commonName)
        .first<{ instance_id: string }>()
      if (caller === null || caller.instance_id.length === 0) throw new Error("access_denied")
      return { instanceId: caller.instance_id }
    }
  }
}
