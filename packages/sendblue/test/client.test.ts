import { describe, expect, it, vi } from "vitest"

import { createSendblueClient } from "../src/client.ts"

const claim = {
  outboxId: "018e6f65-4d55-7a1b-8df4-4ee15ea1db9f",
  attemptId: "018e6f65-4d55-7a1b-8df4-4ee15ea1dba0",
  number: "+46700000000",
  fromNumber: "+46711111111",
  smsSafeText: "Reminder test",
  correlationId: "018e6f65-4d55-7a1b-8df4-4ee15ea1dba1",
  claimedAt: "2026-08-11T10:00:00.000Z"
} as const

describe("Sendblue client", () => {
  it("returns uncertain when a dispatched request loses its response", async () => {
    const request = vi.fn<typeof fetch>().mockRejectedValue(new TypeError("network"))
    const client = createSendblueClient({ apiKeyId: "id", apiSecretKey: "secret", fetch: request })
    await expect(client.sendMessage(claim)).resolves.toEqual({
      state: "uncertain",
      code: "network"
    })
    expect(request).toHaveBeenCalledOnce()
  })

  it("returns accepted only with a provider handle", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ message_handle: "provider-1", status: "QUEUED" }))
    const client = createSendblueClient({ apiKeyId: "id", apiSecretKey: "secret", fetch: request })
    await expect(client.sendMessage(claim)).resolves.toEqual({
      state: "accepted",
      providerMessageHandle: "provider-1"
    })
  })
})
