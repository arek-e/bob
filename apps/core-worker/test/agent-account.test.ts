import { describe, expect, it, vi } from "vitest"

import { makeAgentAccountClient } from "../src/modules/connections/agent-account.ts"

describe("agent account client", () => {
  it("validates status and sends the dedicated Access credentials", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        configured: true,
        provider: "openai-codex",
        accountIdRedacted: "…1234",
        expiresAt: "2026-08-11T12:30:00.000Z"
      })
    )
    const client = makeAgentAccountClient({
      url: "https://agent-admin.example.invalid",
      accessClientId: "client-id",
      accessClientSecret: "client-secret",
      fetch: request
    })

    await expect(client.getStatus()).resolves.toMatchObject({
      configured: true,
      accountIdRedacted: "…1234"
    })
    expect(request).toHaveBeenCalledWith(
      new URL("https://agent-admin.example.invalid/v1/admin/auth/status"),
      expect.objectContaining({
        headers: {
          "CF-Access-Client-Id": "client-id",
          "CF-Access-Client-Secret": "client-secret"
        }
      })
    )
  })

  it("rejects an invalid administration response", async () => {
    const client = makeAgentAccountClient({
      url: "https://agent-admin.example.invalid",
      accessClientId: "client-id",
      accessClientSecret: "client-secret",
      fetch: vi.fn<typeof fetch>().mockResolvedValue(Response.json({ configured: "yes" }))
    })

    await expect(client.getStatus()).rejects.toThrow()
  })
})
