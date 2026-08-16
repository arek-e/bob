import { Context, Layer } from "effect"

export type AccessScope = "run" | "admin"

export interface AccessIdentity {
  readonly scope: AccessScope
}

export interface AccessVerifier {
  verify(request: Request, scope: AccessScope): Promise<AccessIdentity>
}

export const AccessVerifier = Context.Service<AccessVerifier>("bob/AccessVerifier")

export function createSharedSecretAccessVerifier(secret: string): AccessVerifier {
  const expected = new TextEncoder().encode(secret)
  return {
    async verify(request, scope) {
      const supplied = request.headers.get("x-bob-caller-token")
      if (supplied === null) throw new Error("access_denied")
      const suppliedHash = new Uint8Array(
        await crypto.subtle.digest("SHA-256", new TextEncoder().encode(supplied))
      )
      const expectedHash = new Uint8Array(await crypto.subtle.digest("SHA-256", expected))
      let difference = suppliedHash.byteLength ^ expectedHash.byteLength
      for (let index = 0; index < Math.min(suppliedHash.length, expectedHash.length); index += 1) {
        difference |= suppliedHash[index]! ^ expectedHash[index]!
      }
      if (difference !== 0) throw new Error("access_denied")
      return { scope }
    }
  }
}

export function accessVerifierLayer(service: AccessVerifier) {
  return Layer.succeed(AccessVerifier, service)
}
