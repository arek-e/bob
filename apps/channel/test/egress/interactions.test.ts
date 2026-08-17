import { Schema } from "effect"
import { afterEach, describe, expect, it, vi } from "vitest"

import type { EgressBindings } from "../../src/egress/bindings.ts"

import { handleDeliveryReconciliationRequest, handleInteractionRequest } from "../runtime.ts"

// SAFETY: This controlled test fixture matches the asserted contract used by this test.
const bindings = {
  CORE: { fetch: vi.fn(), connect: vi.fn() },
  INGRESS: { fetch: vi.fn(), connect: vi.fn() },
  DELIVERY_RESULT_QUEUE: {
    send: vi.fn(),
    sendBatch: vi.fn(),
    metrics: vi.fn()
  },
  SENDBLUE_API_KEY_ID: "key",
  SENDBLUE_API_SECRET_KEY: "secret",
  SENDBLUE_FROM_NUMBER: "+46711111111",
  SENDBLUE_ALLOWED_USER_NUMBER: "+46700000000",
  SENDBLUE_WEBHOOK_SIGNING_SECRET: "s".repeat(64),
  SENDBLUE_STATUS_CALLBACK_URL: "https://ingress.example.invalid/webhooks/outbound",
  CORE_CALLER_SECRET: "c".repeat(64),
  OTEL_EXPORTER_OTLP_ENDPOINT: "",
  BOB_RELEASE_SHA: ""
} as EgressBindings

afterEach(() => {
  vi.unstubAllGlobals()
})

const outboundHistory = {
  accountEmail: "owner@example.invalid",
  content: "Reminder test",
  is_outbound: true,
  status: "DELIVERED",
  error_code: null,
  error_message: null,
  error_reason: null,
  message_handle: "provider-history-1",
  date_sent: "2026-08-13T10:30:00.000Z",
  date_updated: "2026-08-13T10:31:00.000Z",
  from_number: "+46711111111",
  number: "+46700000000",
  to_number: "+46700000000",
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

function interactionRequest(body: typeof Schema.Json.Type, token = "c".repeat(64)) {
  return new Request("https://egress.example.invalid/internal/message-interaction", {
    method: "POST",
    headers: { "content-type": "application/json", "x-bob-caller-token": token },
    body: JSON.stringify(body)
  })
}

describe("Sendblue message interactions", () => {
  it("reconciles a known provider handle without message content", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ message_handle: "provider-1", status: "DELIVERED" }))
    )
    const response = await handleDeliveryReconciliationRequest(
      new Request("https://egress.example.invalid/internal/delivery-reconciliation", {
        method: "POST",
        headers: { "content-type": "application/json", "x-bob-caller-token": "c".repeat(64) },
        body: JSON.stringify({
          outboxId: "018e6f65-4d55-7a1b-8df4-4ee15ea1db9f",
          attemptId: "018e6f65-4d55-7a1b-8df4-4ee15ea1dba0",
          correlationId: "018e6f65-4d55-7a1b-8df4-4ee15ea1dba1",
          providerMessageHandle: "provider-1"
        })
      }),
      bindings
    )

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      status: "resolved",
      result: {
        state: "delivered",
        providerMessageHandle: "provider-1"
      }
    })
  })

  it("finds one handleless send through bounded provider history", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({ status: "OK", data: [outboundHistory], pagination: { total: 1 } })
      )
    )
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(outboundHistory.content)
    )
    const payloadFingerprint = [...new Uint8Array(digest)]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("")
    const response = await handleDeliveryReconciliationRequest(
      new Request("https://egress.example.invalid/internal/delivery-reconciliation", {
        method: "POST",
        headers: { "content-type": "application/json", "x-bob-caller-token": "c".repeat(64) },
        body: JSON.stringify({
          outboxId: "018e6f65-4d55-7a1b-8df4-4ee15ea1db9f",
          attemptId: "018e6f65-4d55-7a1b-8df4-4ee15ea1dba0",
          correlationId: "018e6f65-4d55-7a1b-8df4-4ee15ea1dba1",
          destinationE164: "+46700000000",
          payloadFingerprint,
          since: "2026-08-13T10:25:00.000Z",
          until: "2026-08-13T10:45:00.000Z"
        })
      }),
      bindings
    )

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      status: "resolved",
      result: {
        state: "delivered",
        providerMessageHandle: "provider-history-1",
        occurredAt: "2026-08-13T10:31:00.000Z"
      }
    })
  })

  it("rejects unauthenticated requests", async () => {
    const response = await handleInteractionRequest(
      interactionRequest({ action: "stop" }, "wrong"),
      bindings
    )
    expect(response.status).toBe(401)
  })

  it("sends a like reaction and starts typing", async () => {
    const requests: Array<{ url: string; body: unknown }> = []
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        requests.push({ url: String(input), body: JSON.parse(String(init?.body)) })
        return new Response(null, { status: 200 })
      })
    )

    const response = await handleInteractionRequest(
      interactionRequest({
        action: "start",
        number: "+46700000000",
        fromNumber: "+46711111111",
        messageHandle: "inbound-1",
        react: true,
        maxDurationMs: 90_000
      }),
      bindings
    )

    expect(response.status).toBe(200)
    expect(requests).toEqual(
      expect.arrayContaining([
        {
          url: "https://api.sendblue.com/api/send-reaction",
          body: {
            from_number: "+46711111111",
            message_handle: "inbound-1",
            reaction: "like"
          }
        },
        {
          url: "https://api.sendblue.com/api/send-typing-indicator",
          body: {
            number: "+46700000000",
            from_number: "+46711111111",
            state: "start",
            max_duration_ms: 90_000
          }
        }
      ])
    )
  })

  it("stops typing without sending another reaction", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 200 }))
    vi.stubGlobal("fetch", request)

    await handleInteractionRequest(
      interactionRequest({
        action: "stop",
        number: "+46700000000",
        fromNumber: "+46711111111"
      }),
      bindings
    )

    expect(request).toHaveBeenCalledOnce()
    expect(String(request.mock.calls[0]?.[0])).toBe(
      "https://api.sendblue.com/api/send-typing-indicator"
    )
    expect(JSON.parse(String(request.mock.calls[0]?.[1]?.body))).toEqual({
      number: "+46700000000",
      from_number: "+46711111111",
      state: "stop"
    })
  })
})
