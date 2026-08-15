import { describe, expect, it } from "vitest"

import { createStagedPayloadProtection } from "../src/payload-protection.ts"

describe("Staged payload protection", () => {
  it("encrypts content and binds it to the route", async () => {
    const key = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
    const protection = createStagedPayloadProtection(key, "v1")
    const plaintext = JSON.stringify({ text: "private first event" })

    const protectedPayload = await protection.encrypt("route-1", "provider-1", plaintext)

    expect(protectedPayload.ciphertext).not.toContain("private first event")
    await expect(protection.decrypt("route-1", "provider-1", protectedPayload)).resolves.toBe(
      plaintext
    )
    await expect(protection.decrypt("route-2", "provider-1", protectedPayload)).rejects.toThrow()
  })
})
