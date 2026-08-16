import { generateKeyPair, SignJWT } from "jose"
import { describe, expect, it } from "vitest"

import { verifyInstanceAssertion } from "../src/identity.ts"

describe("Connections Gateway Instance identity", () => {
  it("accepts a service identity and returns only its registered common name", async () => {
    const { privateKey, publicKey } = await generateKeyPair("EdDSA")
    const assertion = await new SignJWT({ common_name: "access-client-a" })
      .setProtectedHeader({ alg: "EdDSA" })
      .setIssuer("https://team.cloudflareaccess.com")
      .setAudience("connections-audience")
      .setSubject("")
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(privateKey)

    await expect(
      verifyInstanceAssertion(assertion, publicKey, {
        issuer: "https://team.cloudflareaccess.com",
        audience: "connections-audience"
      })
    ).resolves.toBe("access-client-a")
  })

  it("rejects an owner identity", async () => {
    const { privateKey, publicKey } = await generateKeyPair("EdDSA")
    const assertion = await new SignJWT({
      common_name: "access-client-a",
      email: "owner@example.invalid"
    })
      .setProtectedHeader({ alg: "EdDSA" })
      .setIssuer("https://team.cloudflareaccess.com")
      .setAudience("connections-audience")
      .setSubject("owner-subject")
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(privateKey)

    await expect(
      verifyInstanceAssertion(assertion, publicKey, {
        issuer: "https://team.cloudflareaccess.com",
        audience: "connections-audience"
      })
    ).rejects.toThrow("access_denied")
  })
})
