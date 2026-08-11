import { parseTraceparent } from "@bob/observability/trace"
import { describe, expect, it, vi } from "vitest"

import { handleIngressHttp } from "../src/entrypoints/http.ts"

const payload = {
  accountEmail: "owner@example.invalid",
  content: "PING",
  is_outbound: false,
  status: "RECEIVED",
  error_code: null,
  error_message: null,
  error_reason: null,
  message_handle: "handle-1",
  date_sent: "2026-08-11T10:00:00.000Z",
  date_updated: "2026-08-11T10:00:00.000Z",
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

function bindings(queueSend = vi.fn().mockResolvedValue(undefined)) {
  const coreFetch = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
    const url = String(input)
    if (url.endsWith("/internal/inbound")) {
      return Response.json({
        eventId: "018e6f65-4d55-7a1b-8df4-4ee15ea1db9f",
        duplicate: false,
        shouldEnqueue: true
      })
    }
    return Response.json({ ok: true })
  })
  return {
    value: {
      CORE: { fetch: coreFetch },
      INBOUND_QUEUE: { send: queueSend },
      SENDBLUE_ACCOUNT_ID: "account",
      SENDBLUE_LINE_ID: "line",
      SENDBLUE_WEBHOOK_SIGNING_SECRET: "s".repeat(64),
      SENDBLUE_FROM_NUMBER: "+46711111111",
      SENDBLUE_ALLOWED_USER_NUMBER: "+46700000000",
      CORE_CALLER_SECRET: "c".repeat(64)
    },
    coreFetch,
    queueSend
  }
}

function request(secret?: string) {
  return new Request("https://bob.example/webhooks/receive", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(secret === undefined ? {} : { "sb-signing-secret": secret })
    },
    body: JSON.stringify(payload)
  })
}

describe("Sendblue ingress", () => {
  it("rejects a missing or wrong secret before any durable write", async () => {
    const target = bindings()
    expect((await handleIngressHttp(request(), target.value as never)).status).toBe(401)
    expect((await handleIngressHttp(request("wrong"), target.value as never)).status).toBe(401)
    expect(target.coreFetch).not.toHaveBeenCalled()
  })

  it("rejects an unknown sender", async () => {
    const target = bindings()
    const bad = { ...payload, from_number: "+46799999999", number: "+46799999999" }
    const response = await handleIngressHttp(
      new Request("https://bob.example/webhooks/receive", {
        method: "POST",
        headers: { "sb-signing-secret": "s".repeat(64) },
        body: JSON.stringify(bad)
      }),
      target.value as never
    )
    expect(response.status).toBe(403)
    expect(target.coreFetch).not.toHaveBeenCalled()
  })

  it("rejects a status callback for another protected destination", async () => {
    const target = bindings()
    const response = await handleIngressHttp(
      new Request("https://bob.example/webhooks/outbound", {
        method: "POST",
        headers: { "sb-signing-secret": "s".repeat(64) },
        body: JSON.stringify({
          ...payload,
          is_outbound: true,
          status: "ACCEPTED",
          from_number: "+46711111111",
          to_number: "+46799999999"
        })
      }),
      target.value as never
    )
    expect(response.status).toBe(403)
    expect(target.coreFetch).not.toHaveBeenCalled()
  })

  it("continues the provider trace through a status callback", async () => {
    const target = bindings()
    const traceparent = "00-018e6f654d557a1b8df44ee15ea1dba1-1111111111111111-01"
    const response = await handleIngressHttp(
      new Request(
        `https://bob.example/webhooks/outbound?outbox_id=018e6f65-4d55-7a1b-8df4-4ee15ea1db9f&attempt_id=018e6f65-4d55-7a1b-8df4-4ee15ea1dba0&traceparent=${encodeURIComponent(traceparent)}`,
        {
          method: "POST",
          headers: { "sb-signing-secret": "s".repeat(64) },
          body: JSON.stringify({
            ...payload,
            is_outbound: true,
            status: "ACCEPTED",
            from_number: "+46711111111",
            to_number: "+46700000000"
          })
        }
      ),
      target.value as never
    )
    expect(response.status).toBe(202)
    const forwarded = new Headers(target.coreFetch.mock.calls[0]?.[1]?.headers)
    expect(parseTraceparent(forwarded.get("traceparent"))?.traceId).toBe(
      "018e6f654d557a1b8df44ee15ea1dba1"
    )
  })

  it("returns 503 after the D1 write when Queue publication fails", async () => {
    const queueSend = vi.fn().mockRejectedValue(new Error("queue down"))
    const target = bindings(queueSend)
    const response = await handleIngressHttp(request("s".repeat(64)), target.value as never)
    expect(response.status).toBe(503)
    expect(target.coreFetch).toHaveBeenCalledOnce()
    expect(queueSend).toHaveBeenCalledOnce()
  })

  it("publishes only opaque identifiers and trace context", async () => {
    const target = bindings()
    const response = await handleIngressHttp(request("s".repeat(64)), target.value as never)
    expect(response.status).toBe(202)
    expect(target.queueSend).toHaveBeenCalledWith({
      eventId: "018e6f65-4d55-7a1b-8df4-4ee15ea1db9f",
      traceparent: expect.stringMatching(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/)
    })
  })
})
