import { describe, expect, it, vi } from "vitest"

import { reconcileInboundHistory } from "../runtime.ts"

const ownerInbound = {
  accountEmail: "owner@example.invalid",
  content: "PING",
  is_outbound: false,
  status: "RECEIVED" as const,
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

describe("Sendblue inbound history reconciliation", () => {
  it("replays only owner messages through the normal signed ingress path", async () => {
    const history = {
      hasLine: vi.fn().mockResolvedValue(true),
      listInbound: vi
        .fn()
        .mockResolvedValue([
          { ...ownerInbound, message_handle: "handle-2", date_sent: "2026-08-13T10:31:00.000Z" },
          ownerInbound,
          { ...ownerInbound, message_handle: "other", from_number: "+46722222222" }
        ])
    }
    const accept = vi.fn(
      async (_request: { headers: Readonly<Record<string, string>>; body: string }) =>
        new Response(null, { status: 202 })
    )

    const result = await reconcileInboundHistory({
      history,
      sendblueNumber: "+46711111111",
      ownerNumber: "+46700000000",
      signingSecret: "s".repeat(64),
      scheduledAt: new Date("2026-08-13T10:32:00.000Z"),
      accept
    })

    expect(history.hasLine).toHaveBeenCalledWith("+46711111111")
    expect(history.listInbound).toHaveBeenCalledWith({
      sendblueNumber: "+46711111111",
      since: new Date("2026-08-13T10:17:00.000Z"),
      until: new Date("2026-08-13T10:33:00.000Z")
    })
    expect(accept).toHaveBeenCalledTimes(2)
    expect(JSON.parse(String(accept.mock.calls[0]?.[0].body))).toMatchObject({
      message_handle: "handle-1"
    })
    expect(JSON.parse(String(accept.mock.calls[1]?.[0].body))).toMatchObject({
      message_handle: "handle-2"
    })
    expect(accept.mock.calls[0]?.[0].headers).toEqual({
      "content-type": "application/json",
      "sb-signing-secret": "s".repeat(64)
    })
    expect(result).toEqual({ retrieved: 3, replayed: 2, skipped: 1 })
  })

  it("fails when the configured provider line is not assigned", async () => {
    await expect(
      reconcileInboundHistory({
        history: {
          hasLine: vi.fn().mockResolvedValue(false),
          listInbound: vi.fn()
        },
        sendblueNumber: "+46711111111",
        ownerNumber: "+46700000000",
        signingSecret: "s".repeat(64),
        scheduledAt: new Date("2026-08-13T10:32:00.000Z"),
        accept: vi.fn()
      })
    ).rejects.toMatchObject({
      _tag: "InboundReconciliationError",
      code: "sendblue_line_unavailable",
      message: "sendblue_line_unavailable"
    })
  })

  it("retains the failed ingress response status", async () => {
    await expect(
      reconcileInboundHistory({
        history: {
          hasLine: vi.fn().mockResolvedValue(true),
          listInbound: vi.fn().mockResolvedValue([ownerInbound])
        },
        sendblueNumber: "+46711111111",
        ownerNumber: "+46700000000",
        signingSecret: "s".repeat(64),
        scheduledAt: new Date("2026-08-13T10:32:00.000Z"),
        accept: vi.fn(async () => new Response(null, { status: 503 }))
      })
    ).rejects.toMatchObject({
      _tag: "InboundReconciliationError",
      code: "sendblue_history_replay_failed",
      status: 503,
      message: "sendblue_history_replay_http_503"
    })
  })
})
