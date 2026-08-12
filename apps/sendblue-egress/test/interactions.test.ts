import { afterEach, describe, expect, it, vi } from "vitest"

import type { EgressBindings } from "../src/bindings.ts"

import { handleInteractionRequest } from "../src/entrypoints/http.ts"

const bindings = {
  CORE: { fetch: vi.fn() },
  DELIVERY_RESULT_QUEUE: { send: vi.fn() },
  SENDBLUE_API_KEY_ID: "key",
  SENDBLUE_API_SECRET_KEY: "secret",
  SENDBLUE_STATUS_CALLBACK_URL: "https://ingress.example.invalid/webhooks/outbound",
  CORE_CALLER_SECRET: "c".repeat(64)
} as unknown as EgressBindings

afterEach(() => {
  vi.unstubAllGlobals()
})

function interactionRequest(body: unknown, token = "c".repeat(64)) {
  return new Request("https://egress.example.invalid/internal/message-interaction", {
    method: "POST",
    headers: { "content-type": "application/json", "x-bob-caller-token": token },
    body: JSON.stringify(body)
  })
}

describe("Sendblue message interactions", () => {
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
