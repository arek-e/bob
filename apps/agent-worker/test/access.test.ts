import { describe, expect, it } from "vitest"

import { createSharedSecretAccessVerifier } from "../src/access.ts"

describe("agent access", () => {
  it("accepts the shared caller secret", async () => {
    const verifier = createSharedSecretAccessVerifier("s".repeat(64))
    const request = new Request("https://agent.test/v1/run", {
      headers: { "x-bob-caller-token": "s".repeat(64) }
    })

    await expect(verifier.verify(request, "run")).resolves.toEqual({ scope: "run" })
  })

  it("rejects a different caller secret", async () => {
    const verifier = createSharedSecretAccessVerifier("s".repeat(64))
    const request = new Request("https://agent.test/v1/run", {
      headers: { "x-bob-caller-token": "x".repeat(64) }
    })

    await expect(verifier.verify(request, "run")).rejects.toThrow("access_denied")
  })
})
