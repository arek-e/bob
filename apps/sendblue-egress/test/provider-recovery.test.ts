import { afterEach, describe, expect, it, vi } from "vitest"

import { handleScheduledReconcile } from "../src/entrypoints/provider-recovery.ts"

const inbound = {
  accountEmail: "owner@example.invalid",
  content: "PING",
  is_outbound: false,
  status: "RECEIVED",
  error_code: null,
  error_message: null,
  error_reason: null,
  message_handle: "handle-recovered",
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

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe("Sendblue provider recovery", () => {
  it("recovers an inbound provider message that had no webhook", async () => {
    const ingressFetch = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(null, { status: 202 })
    )
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input)
        if (url.endsWith("/api/lines")) {
          return Response.json({ numbers: ["+46711111111"] })
        }
        if (url.startsWith("https://api.sendblue.com/api/v2/messages?")) {
          return Response.json({ status: "OK", data: [inbound], pagination: { total: 1 } })
        }
        throw new Error("unexpected_request")
      })
    )
    vi.spyOn(console, "log").mockImplementation(() => undefined)

    const result = await handleScheduledReconcile(new Date("2026-08-13T10:32:00.000Z"), {
      INGRESS: { fetch: ingressFetch },
      SENDBLUE_API_KEY_ID: "key-id",
      SENDBLUE_API_SECRET_KEY: "secret-key",
      SENDBLUE_WEBHOOK_SIGNING_SECRET: "s".repeat(64),
      SENDBLUE_FROM_NUMBER: "+46711111111",
      SENDBLUE_ALLOWED_USER_NUMBER: "+46700000000"
    } as never)

    expect(result).toEqual({ retrieved: 1, replayed: 1, skipped: 0 })
    expect(ingressFetch).toHaveBeenCalledTimes(1)
    const request = ingressFetch.mock.calls[0]
    expect(String(request?.[0])).toBe("https://ingress.internal/webhooks/receive")
    expect(request?.[1]).toMatchObject({
      method: "POST",
      headers: {
        "content-type": "application/json",
        "sb-signing-secret": "s".repeat(64)
      }
    })
    expect(JSON.parse(String(request?.[1]?.body))).toMatchObject({
      message_handle: "handle-recovered",
      content: "PING"
    })
  })

  it("emits a content-free failure when the configured line is unavailable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ numbers: [] }))
    )
    const errors: string[] = []
    vi.spyOn(console, "error").mockImplementation((line) => errors.push(String(line)))

    await expect(
      handleScheduledReconcile(new Date("2026-08-13T10:32:00.000Z"), {
        INGRESS: { fetch: vi.fn() },
        SENDBLUE_API_KEY_ID: "key-id",
        SENDBLUE_API_SECRET_KEY: "secret-key",
        SENDBLUE_WEBHOOK_SIGNING_SECRET: "s".repeat(64),
        SENDBLUE_FROM_NUMBER: "+46711111111",
        SENDBLUE_ALLOWED_USER_NUMBER: "+46700000000"
      } as never)
    ).rejects.toThrow("sendblue_line_unavailable")
    expect(errors.map((line) => JSON.parse(line))).toEqual([
      {
        type: "inbound_reconcile",
        status: "failed",
        code: "sendblue_line_unavailable"
      }
    ])
  })
})
