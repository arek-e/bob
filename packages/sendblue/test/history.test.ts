import { describe, expect, it, vi } from "vitest"

import { createSendblueHistoryClient } from "../src/history.ts"

const inbound = {
  accountEmail: "owner@example.invalid",
  content: "PING",
  is_outbound: false,
  status: "RECEIVED",
  error_code: null,
  error_message: null,
  error_reason: null,
  message_handle: "handle-1",
  date_sent: "2026-08-13T10:30:00.000Z",
  date_updated: "2026-08-13T10:30:00.000Z",
  from_number: "+46700000000",
  number: "+46700000000",
  to_number: "+46711111111",
  was_downgraded: null,
  plan: "dedicated",
  media_url: "",
  message_type: "message",
  group_id: "",
  participants: ["+46700000000", "+46711111111"],
  send_style: "",
  opted_out: false,
  error_detail: null,
  sendblue_number: "+46711111111",
  service: "iMessage",
  group_display_name: null
}

describe("Sendblue history client", () => {
  it("lists inbound messages for one line and a bounded time window", async () => {
    const request = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      Response.json({ status: "OK", data: [inbound], pagination: { total: 1 } })
    )
    const client = createSendblueHistoryClient({
      apiKeyId: "key-id",
      apiSecretKey: "secret-key",
      baseUrl: "https://sendblue.example.test",
      fetch: request as typeof fetch
    })

    const result = await client.listInbound({
      sendblueNumber: "+46711111111",
      since: new Date("2026-08-13T10:20:00.000Z"),
      until: new Date("2026-08-13T10:31:00.000Z")
    })

    expect(result).toEqual([inbound])
    const url = new URL(String(request.mock.calls[0]?.[0]))
    expect(url.pathname).toBe("/api/v2/messages")
    expect(Object.fromEntries(url.searchParams)).toEqual({
      is_outbound: "false",
      limit: "1000",
      sendblue_number: "+46711111111",
      sent_at_gte: "2026-08-13T10:20:00.000Z",
      sent_at_lte: "2026-08-13T10:31:00.000Z"
    })
    expect(request.mock.calls[0]?.[1]).toEqual({
      headers: {
        "sb-api-key-id": "key-id",
        "sb-api-secret-key": "secret-key"
      }
    })
  })

  it("checks that the configured line remains assigned", async () => {
    const request = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      Response.json({ numbers: ["+46711111111"] })
    )
    const client = createSendblueHistoryClient({
      apiKeyId: "key-id",
      apiSecretKey: "secret-key",
      baseUrl: "https://sendblue.example.test",
      fetch: request as typeof fetch
    })

    await expect(client.hasLine("+46711111111")).resolves.toBe(true)
    expect(String(request.mock.calls[0]?.[0])).toBe("https://sendblue.example.test/api/lines")
  })
})
