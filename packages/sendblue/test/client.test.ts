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

  it("validates provider status through a timed request", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ message_handle: "provider-1", status: "DELIVERED" }))
    const client = createSendblueClient({ apiKeyId: "id", apiSecretKey: "secret", fetch: request })

    await expect(client.getStatus("provider-1")).resolves.toEqual({
      message_handle: "provider-1",
      status: "DELIVERED"
    })
    expect(request.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal)
  })

  it("sends a reaction with the documented provider fields", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 200 }))
    const client = createSendblueClient({ apiKeyId: "id", apiSecretKey: "secret", fetch: request })

    await expect(
      client.sendReaction({
        fromNumber: "+46711111111",
        messageHandle: "inbound-1",
        reaction: "like"
      })
    ).resolves.toEqual({ state: "accepted" })

    expect(JSON.parse(String(request.mock.calls[0]?.[1]?.body))).toEqual({
      from_number: "+46711111111",
      message_handle: "inbound-1",
      reaction: "like"
    })
  })

  it("starts and stops the typing indicator", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 200 }))
    const client = createSendblueClient({ apiKeyId: "id", apiSecretKey: "secret", fetch: request })

    await client.sendTypingIndicator({
      number: "+46700000000",
      fromNumber: "+46711111111",
      state: "start",
      maxDurationMs: 90_000
    })
    await client.sendTypingIndicator({
      number: "+46700000000",
      fromNumber: "+46711111111",
      state: "stop"
    })

    expect(request.mock.calls.map((call) => JSON.parse(String(call[1]?.body)))).toEqual([
      {
        number: "+46700000000",
        from_number: "+46711111111",
        state: "start",
        max_duration_ms: 90_000
      },
      {
        number: "+46700000000",
        from_number: "+46711111111",
        state: "stop"
      }
    ])
  })

  it("falls back to a standard message after a safe inline reply rejection", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 400 }))
      .mockResolvedValueOnce(Response.json({ message_handle: "provider-2", status: "QUEUED" }))
    const client = createSendblueClient({ apiKeyId: "id", apiSecretKey: "secret", fetch: request })

    await expect(
      client.sendMessage({ ...claim, replyToMessageHandle: "inbound-1" })
    ).resolves.toEqual({ state: "accepted", providerMessageHandle: "provider-2" })

    const bodies = request.mock.calls.map((call) => JSON.parse(String(call[1]?.body)))
    expect(bodies[0]).toEqual(
      expect.objectContaining({ reply_to: { message_handle: "inbound-1" } })
    )
    expect(bodies[1]).not.toHaveProperty("reply_to")
  })
})
