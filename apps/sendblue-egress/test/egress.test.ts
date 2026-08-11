import { afterEach, describe, expect, it, vi } from "vitest"

import { processOutboundJob } from "../src/entrypoints/queue.ts"

const outboxId = "018e6f65-4d55-7a1b-8df4-4ee15ea1db9f"
const attemptId = "018e6f65-4d55-7a1b-8df4-4ee15ea1dba0"

afterEach(() => vi.unstubAllGlobals())

describe("Sendblue egress", () => {
  it("records uncertainty and does not request an automatic retry", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("response lost")))
    const calls: { url: string; body?: unknown }[] = []
    const core = {
      fetch: vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input)
        calls.push({
          url,
          ...(init?.body === undefined ? {} : { body: JSON.parse(String(init.body)) as unknown })
        })
        if (url.endsWith("/claim")) {
          return Response.json({
            outboxId,
            attemptId,
            number: "+46700000000",
            fromNumber: "+46711111111",
            smsSafeText: "Reminder test",
            correlationId: "018e6f65-4d55-7a1b-8df4-4ee15ea1dba1",
            claimedAt: "2026-08-11T10:00:00.000Z"
          })
        }
        return Response.json({ ok: true })
      })
    }
    const results: unknown[] = []
    const outcome = await processOutboundJob({ outboxId }, {
      CORE: core,
      DELIVERY_RESULT_QUEUE: {
        send: async (body: unknown) => {
          results.push(body)
        }
      },
      SENDBLUE_API_KEY_ID: "key",
      SENDBLUE_API_SECRET_KEY: "secret",
      SENDBLUE_STATUS_CALLBACK_URL: "https://bob.example/webhooks/outbound",
      CORE_CALLER_SECRET: "c".repeat(64)
    } as never)
    expect(outcome).toBe("done")
    expect(calls).toHaveLength(1)
    expect(results).toEqual([expect.objectContaining({ state: "uncertain", errorCode: "network" })])
  })

  it("durably publishes an accepted provider handle before it completes", async () => {
    const providerRequests: unknown[] = []
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        providerRequests.push(JSON.parse(String(init?.body)) as unknown)
        return Response.json({ message_handle: "sendblue-handle", status: "ACCEPTED" })
      })
    )
    const traceparent = "00-018e6f654d557a1b8df44ee15ea1dba1-1111111111111111-01"
    const claimRequests: Headers[] = []
    const core = {
      fetch: vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        claimRequests.push(new Headers(init?.headers))
        return Response.json({
          outboxId,
          attemptId,
          number: "+46700000000",
          fromNumber: "+46711111111",
          smsSafeText: "Reminder test",
          correlationId: "018e6f65-4d55-7a1b-8df4-4ee15ea1dba1",
          claimedAt: "2026-08-11T10:00:00.000Z"
        })
      })
    }
    let result: unknown
    const outcome = await processOutboundJob({ outboxId, traceparent }, {
      CORE: core,
      DELIVERY_RESULT_QUEUE: {
        send: async (body: unknown) => {
          result = body
        }
      },
      SENDBLUE_API_KEY_ID: "key",
      SENDBLUE_API_SECRET_KEY: "secret",
      SENDBLUE_STATUS_CALLBACK_URL: "https://bob.example/webhooks/outbound",
      CORE_CALLER_SECRET: "c".repeat(64)
    } as never)

    expect(outcome).toBe("done")
    expect(result).toMatchObject({
      outboxId,
      attemptId,
      state: "accepted",
      providerMessageHandle: "sendblue-handle"
    })
    expect(claimRequests[0]?.get("traceparent")).toBe(traceparent)
    expect(providerRequests).toEqual([
      expect.objectContaining({
        status_callback: expect.stringMatching(
          /^https:\/\/bob\.example\/webhooks\/outbound\?outbox_id=.*&attempt_id=.*&traceparent=00-018e6f654d557a1b8df44ee15ea1dba1-[0-9a-f]{16}-01$/
        )
      })
    ])
  })

  it("uses the durable Core store when result Queue publication fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(Response.json({ message_handle: "sendblue-handle" }))
    )
    const core = {
      fetch: vi.fn(async () =>
        Response.json({
          outboxId,
          attemptId,
          number: "+46700000000",
          fromNumber: "+46711111111",
          smsSafeText: "Reminder test",
          correlationId: "018e6f65-4d55-7a1b-8df4-4ee15ea1dba1",
          claimedAt: "2026-08-11T10:00:00.000Z"
        })
      )
    }
    const outcome = await processOutboundJob({ outboxId }, {
      CORE: core,
      DELIVERY_RESULT_QUEUE: {
        send: async () => Promise.reject(new Error("queue unavailable"))
      },
      SENDBLUE_API_KEY_ID: "key",
      SENDBLUE_API_SECRET_KEY: "secret",
      SENDBLUE_STATUS_CALLBACK_URL: "https://bob.example/webhooks/outbound",
      CORE_CALLER_SECRET: "c".repeat(64)
    } as never)

    expect(outcome).toBe("done")
    expect(core.fetch).toHaveBeenCalledTimes(2)
  })

  it("does not complete when both durable result paths fail", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(Response.json({ message_handle: "sendblue-handle" }))
    )
    const core = {
      fetch: vi.fn(async (input: RequestInfo | URL) =>
        String(input).endsWith("/claim")
          ? Response.json({
              outboxId,
              attemptId,
              number: "+46700000000",
              fromNumber: "+46711111111",
              smsSafeText: "Reminder test",
              correlationId: "018e6f65-4d55-7a1b-8df4-4ee15ea1dba1",
              claimedAt: "2026-08-11T10:00:00.000Z"
            })
          : Response.json({ code: "unavailable" }, { status: 503 })
      )
    }
    const outcome = await processOutboundJob({ outboxId }, {
      CORE: core,
      DELIVERY_RESULT_QUEUE: {
        send: async () => Promise.reject(new Error("queue unavailable"))
      },
      SENDBLUE_API_KEY_ID: "key",
      SENDBLUE_API_SECRET_KEY: "secret",
      SENDBLUE_STATUS_CALLBACK_URL: "https://bob.example/webhooks/outbound",
      CORE_CALLER_SECRET: "c".repeat(64)
    } as never)

    expect(outcome).toBe("retry")
  })
})
