import { generateKeyPair, SignJWT } from "jose"
import { describe, expect, it } from "vitest"

import { verifyServiceTokenAssertion } from "../src/access.ts"

describe("agent Access service tokens", () => {
  it("uses common_name when Cloudflare gives the token an empty subject", async () => {
    const { privateKey, publicKey } = await generateKeyPair("RS256")
    const assertion = await new SignJWT({ common_name: "run-client-id" })
      .setProtectedHeader({ alg: "RS256", kid: "test" })
      .setIssuer("https://team.cloudflareaccess.com")
      .setAudience("run-audience")
      .setSubject("")
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(privateKey)

    await expect(
      verifyServiceTokenAssertion(assertion, publicKey, {
        issuer: "https://team.cloudflareaccess.com",
        audience: "run-audience",
        clientId: "run-client-id",
        scope: "run"
      })
    ).resolves.toEqual({ subject: "", commonName: "run-client-id", scope: "run" })
  })

  it("rejects a signed token for a different service client", async () => {
    const { privateKey, publicKey } = await generateKeyPair("RS256")
    const assertion = await new SignJWT({ common_name: "wrong-client-id" })
      .setProtectedHeader({ alg: "RS256", kid: "test" })
      .setIssuer("https://team.cloudflareaccess.com")
      .setAudience("admin-audience")
      .setSubject("")
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(privateKey)

    await expect(
      verifyServiceTokenAssertion(assertion, publicKey, {
        issuer: "https://team.cloudflareaccess.com",
        audience: "admin-audience",
        clientId: "admin-client-id",
        scope: "admin"
      })
    ).rejects.toThrow("access_denied")
  })
})
