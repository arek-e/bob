import { parseTraceparent } from "@bob/observability/propagation"
import { afterEach, describe, expect, it, vi } from "vitest"

import { handleOutboundQueue, processOutboundJob } from "../src/entrypoints/queue.ts"

const outboxId = "018e6f65-4d55-7a1b-8df4-4ee15ea1db9f"
const attemptId = "018e6f65-4d55-7a1b-8df4-4ee15ea1dba0"
const correlationId = "018e6f65-4d55-7a1b-8df4-4ee15ea1dba1"
const releaseSha = "0123456789abcdef0123456789abcdef01234567"
const telemetryBindings = {
  OTEL_EXPORTER_OTLP_ENDPOINT: "https://otel.example.test",
  OTEL_ACCESS_CLIENT_ID: "otel-client",
  OTEL_ACCESS_CLIENT_SECRET: "otel-secret",
  BOB_RELEASE_SHA: releaseSha
}

interface ExportedSpan {
  readonly name: string
  readonly traceId: string
  readonly spanId: string
  readonly parentSpanId?: string
  readonly status: { readonly code: number }
  readonly events: Array<{ readonly name: string; readonly attributes: unknown }>
}

function expectTraceparentFrom(
  value: string | null | undefined,
  span: ExportedSpan | undefined
): void {
  if (span === undefined) throw new Error("Expected a producing span")
  expect(parseTraceparent(value)).toEqual({
    traceId: span.traceId,
    spanId: span.spanId,
    sampled: true
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

function executionContext() {
  const pending: Promise<unknown>[] = []
  return {
    value: {
      waitUntil(promise: Promise<unknown>) {
        pending.push(promise)
      },
      passThroughOnException() {}
    } as ExecutionContext,
    drain: () => Promise.all(pending)
  }
}

describe("Sendblue egress", () => {
  it("exports and propagates one safe outbound delivery trace", async () => {
    const health: string[] = []
    vi.spyOn(console, "log").mockImplementation((line) => health.push(String(line)))
    const exports: RequestInit[] = []
    const providerRequests: RequestInit[] = []
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input).endsWith("/v1/traces")) {
          if (init !== undefined) exports.push(init)
          return new Response(null, { status: 200 })
        }
        if (init !== undefined) providerRequests.push(init)
        return Response.json({ message_handle: "sendblue-handle", status: "ACCEPTED" })
      })
    )
    const claimHeaders: Headers[] = []
    const core = {
      fetch: vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        claimHeaders.push(new Headers(init?.headers))
        return Response.json({
          outboxId,
          attemptId,
          number: "+46700000000",
          fromNumber: "+46711111111",
          smsSafeText: "Reminder private text",
          correlationId,
          claimedAt: "2026-08-11T10:00:00.000Z"
        })
      })
    }
    const deliveryResults: unknown[] = []
    const context = executionContext()
    const parent = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"

    const outcome = await processOutboundJob(
      { outboxId, correlationId, traceparent: parent },
      {
        CORE: core,
        DELIVERY_RESULT_QUEUE: { send: async (body: unknown) => deliveryResults.push(body) },
        SENDBLUE_API_KEY_ID: "key",
        SENDBLUE_API_SECRET_KEY: "provider-secret",
        SENDBLUE_STATUS_CALLBACK_URL: "https://bob.example/webhooks/outbound",
        CORE_CALLER_SECRET: "c".repeat(64),
        OTEL_EXPORTER_OTLP_ENDPOINT: "https://otel.example.test",
        OTEL_ACCESS_CLIENT_ID: "otel-client",
        OTEL_ACCESS_CLIENT_SECRET: "otel-secret",
        BOB_RELEASE_SHA: releaseSha
      } as never,
      context.value
    )
    await context.drain()

    expect(outcome).toBe("done")
    expect(claimHeaders[0]?.get("traceparent")).toMatch(
      /^00-4bf92f3577b34da6a3ce929d0e0e4736-[0-9a-f]{16}-01$/
    )
    expect(claimHeaders[0]?.get("x-bob-correlation-id")).toBe(correlationId)
    expect(deliveryResults).toEqual([
      expect.objectContaining({
        correlationId,
        traceparent: expect.stringMatching(/^00-4bf92f3577b34da6a3ce929d0e0e4736-[0-9a-f]{16}-01$/)
      })
    ])
    const providerBody = JSON.parse(String(providerRequests[0]?.body)) as {
      status_callback?: string
    }
    expect(providerBody.status_callback).toMatch(
      /traceparent=00-4bf92f3577b34da6a3ce929d0e0e4736-[0-9a-f]{16}-01$/
    )
    expect(exports).toHaveLength(1)
    const exportHeaders = new Headers(exports[0]?.headers)
    expect(exportHeaders.get("cf-access-client-id")).toBe("otel-client")
    expect(exportHeaders.get("cf-access-client-secret")).toBe("otel-secret")
    const exportBody = String(exports[0]?.body)
    const spans = JSON.parse(exportBody).resourceSpans[0].scopeSpans[0].spans as ExportedSpan[]
    expect(spans.map((span) => span.name)).toEqual([
      "bob.outbox.invoke",
      "bob.provider.send",
      "bob.delivery_result.publish",
      "bob.outbox.consume"
    ])
    expect(spans.every((span) => span.traceId === "4bf92f3577b34da6a3ce929d0e0e4736")).toBe(true)
    expect(spans.slice(0, 3).map((span) => span.parentSpanId)).toEqual([
      spans[3]?.spanId,
      spans[3]?.spanId,
      spans[3]?.spanId
    ])
    expect(spans[3]?.parentSpanId).toBe(parseTraceparent(parent)?.spanId)
    expectTraceparentFrom(claimHeaders[0]?.get("traceparent"), spans[0])
    expectTraceparentFrom(
      new URL(providerBody.status_callback!).searchParams.get("traceparent"),
      spans[1]
    )
    const published = deliveryResults[0] as { readonly traceparent?: string }
    expectTraceparentFrom(published.traceparent, spans[2])
    expect(spans[1]?.events).toEqual([
      expect.objectContaining({
        name: "bob.state.transition",
        attributes: expect.arrayContaining([
          { key: "bob.decision.code", value: { stringValue: "provider_control" } }
        ])
      })
    ])
    expect(spans.at(-1)?.events).toEqual([
      expect.objectContaining({
        name: "bob.decision.idempotency",
        attributes: expect.arrayContaining([
          { key: "bob.decision.code", value: { stringValue: "allowed" } }
        ])
      })
    ])
    expect(exportBody).not.toContain("Reminder private text")
    expect(exportBody).not.toContain("+46700000000")
    expect(exportBody).not.toContain("provider-secret")
    expect(exportBody).not.toContain("otel-secret")
    expect(health.map((line) => JSON.parse(line))).toEqual([
      expect.objectContaining({ type: "delivery", status: "accepted", code: "accepted" })
    ])
    expect(health.join("\n")).not.toContain("Reminder private text")
    expect(health.join("\n")).not.toContain("+46700000000")
  })

  it("delivers a valid outbound job when all telemetry bindings are missing", async () => {
    const providerFetch = vi.fn(async (_input: RequestInfo | URL) =>
      Response.json({ message_handle: "sendblue-handle", status: "ACCEPTED" })
    )
    vi.stubGlobal("fetch", providerFetch)
    const core = {
      fetch: vi.fn(async () =>
        Response.json({
          outboxId,
          attemptId,
          number: "+46700000000",
          fromNumber: "+46711111111",
          smsSafeText: "Reminder test",
          correlationId,
          claimedAt: "2026-08-11T10:00:00.000Z"
        })
      )
    }
    const deliveryResults: unknown[] = []
    const context = executionContext()
    const ack = vi.fn()
    const retry = vi.fn()

    await handleOutboundQueue(
      {
        messages: [{ body: { outboxId, correlationId }, ack, retry }]
      } as never,
      {
        CORE: core,
        DELIVERY_RESULT_QUEUE: {
          send: async (body: unknown) => {
            deliveryResults.push(body)
          }
        },
        SENDBLUE_API_KEY_ID: "key",
        SENDBLUE_API_SECRET_KEY: "provider-secret",
        SENDBLUE_STATUS_CALLBACK_URL: "https://bob.example/webhooks/outbound",
        CORE_CALLER_SECRET: "c".repeat(64)
      } as never,
      context.value
    )
    await context.drain()

    expect(ack).toHaveBeenCalledOnce()
    expect(retry).not.toHaveBeenCalled()
    expect(core.fetch).toHaveBeenCalledOnce()
    expect(deliveryResults).toHaveLength(1)
    expect(providerFetch).toHaveBeenCalledOnce()
    expect(String(providerFetch.mock.calls[0]?.[0])).not.toContain("/v1/traces")
  })

  it.each([
    ["OTLP endpoint", { OTEL_EXPORTER_OTLP_ENDPOINT: "not a URL" }],
    ["release SHA", { BOB_RELEASE_SHA: "not-a-release" }],
    ["OTLP Access client ID", { OTEL_ACCESS_CLIENT_ID: "" }],
    ["OTLP Access client secret", { OTEL_ACCESS_CLIENT_SECRET: "" }]
  ])("delivers a valid outbound job when the %s is malformed", async (_name, override) => {
    const providerFetch = vi.fn(async (_input: RequestInfo | URL) =>
      Response.json({ message_handle: "sendblue-handle", status: "ACCEPTED" })
    )
    vi.stubGlobal("fetch", providerFetch)
    const core = {
      fetch: vi.fn(async () =>
        Response.json({
          outboxId,
          attemptId,
          number: "+46700000000",
          fromNumber: "+46711111111",
          smsSafeText: "Reminder test",
          correlationId,
          claimedAt: "2026-08-11T10:00:00.000Z"
        })
      )
    }
    const deliveryResults: unknown[] = []
    const context = executionContext()

    const outcome = await processOutboundJob(
      { outboxId, correlationId },
      {
        CORE: core,
        DELIVERY_RESULT_QUEUE: {
          send: async (body: unknown) => {
            deliveryResults.push(body)
          }
        },
        SENDBLUE_API_KEY_ID: "key",
        SENDBLUE_API_SECRET_KEY: "provider-secret",
        SENDBLUE_STATUS_CALLBACK_URL: "https://bob.example/webhooks/outbound",
        CORE_CALLER_SECRET: "c".repeat(64),
        ...telemetryBindings,
        ...override
      } as never,
      context.value
    )
    await context.drain()

    expect(outcome).toBe("done")
    expect(core.fetch).toHaveBeenCalledOnce()
    expect(deliveryResults).toHaveLength(1)
    expect(providerFetch).toHaveBeenCalledOnce()
    expect(String(providerFetch.mock.calls[0]?.[0])).not.toContain("/v1/traces")
  })

  it("keeps application binding validation strict", async () => {
    const core = { fetch: vi.fn() }

    await expect(
      processOutboundJob({ outboxId, correlationId }, {
        CORE: core,
        DELIVERY_RESULT_QUEUE: { send: vi.fn() },
        SENDBLUE_API_KEY_ID: "key",
        SENDBLUE_API_SECRET_KEY: "provider-secret",
        SENDBLUE_STATUS_CALLBACK_URL: "https://bob.example/webhooks/outbound",
        ...telemetryBindings
      } as never)
    ).rejects.toThrow()
    expect(core.fetch).not.toHaveBeenCalled()
  })

  it("records uncertainty and does not request an automatic retry", async () => {
    const exports: RequestInit[] = []
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input).endsWith("/v1/traces")) {
          if (init !== undefined) exports.push(init)
          return new Response(null, { status: 200 })
        }
        throw new TypeError("response lost")
      })
    )
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
    const context = executionContext()
    const outcome = await processOutboundJob(
      { outboxId, correlationId },
      {
        CORE: core,
        DELIVERY_RESULT_QUEUE: {
          send: async (body: unknown) => {
            results.push(body)
          }
        },
        SENDBLUE_API_KEY_ID: "key",
        SENDBLUE_API_SECRET_KEY: "secret",
        SENDBLUE_STATUS_CALLBACK_URL: "https://bob.example/webhooks/outbound",
        CORE_CALLER_SECRET: "c".repeat(64),
        ...telemetryBindings
      } as never,
      context.value
    )
    await context.drain()
    expect(outcome).toBe("done")
    expect(calls).toHaveLength(1)
    expect(results).toEqual([expect.objectContaining({ state: "uncertain", errorCode: "network" })])
    const spans = JSON.parse(String(exports[0]?.body)).resourceSpans[0].scopeSpans[0]
      .spans as Array<{ name: string; status: { code: number }; events: unknown }>
    expect(spans.find((span) => span.name === "bob.provider.send")).toMatchObject({
      status: { code: 2 },
      events: [
        expect.objectContaining({
          name: "bob.state.transition",
          attributes: expect.arrayContaining([
            { key: "bob.decision.code", value: { stringValue: "external_unknown" } }
          ])
        })
      ]
    })
  })

  it("marks the Core outbox client span failed after a non-success response", async () => {
    const exports: RequestInit[] = []
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input).endsWith("/v1/traces") && init !== undefined) exports.push(init)
        return new Response(null, { status: 200 })
      })
    )
    const context = executionContext()

    const outcome = await processOutboundJob(
      { outboxId, correlationId },
      {
        CORE: {
          fetch: vi.fn(async () => Response.json({ code: "unavailable" }, { status: 503 }))
        },
        DELIVERY_RESULT_QUEUE: { send: vi.fn() },
        SENDBLUE_API_KEY_ID: "key",
        SENDBLUE_API_SECRET_KEY: "provider-secret",
        SENDBLUE_STATUS_CALLBACK_URL: "https://bob.example/webhooks/outbound",
        CORE_CALLER_SECRET: "c".repeat(64),
        ...telemetryBindings
      } as never,
      context.value
    )
    await context.drain()

    expect(outcome).toBe("retry")
    const spans = JSON.parse(String(exports[0]?.body)).resourceSpans[0].scopeSpans[0]
      .spans as ExportedSpan[]
    expect(spans.find((span) => span.name === "bob.outbox.invoke")?.status).toEqual({ code: 2 })
  })

  it("keeps an idempotent Core claim replay successful", async () => {
    const exports: RequestInit[] = []
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input).endsWith("/v1/traces") && init !== undefined) exports.push(init)
        return new Response(null, { status: 200 })
      })
    )
    const context = executionContext()

    const outcome = await processOutboundJob(
      { outboxId, correlationId },
      {
        CORE: {
          fetch: vi.fn(async () => Response.json({ disposition: "replay" }, { status: 409 }))
        },
        DELIVERY_RESULT_QUEUE: { send: vi.fn() },
        SENDBLUE_API_KEY_ID: "key",
        SENDBLUE_API_SECRET_KEY: "provider-secret",
        SENDBLUE_STATUS_CALLBACK_URL: "https://bob.example/webhooks/outbound",
        CORE_CALLER_SECRET: "c".repeat(64),
        ...telemetryBindings
      } as never,
      context.value
    )
    await context.drain()

    expect(outcome).toBe("done")
    const spans = JSON.parse(String(exports[0]?.body)).resourceSpans[0].scopeSpans[0]
      .spans as ExportedSpan[]
    expect(spans.find((span) => span.name === "bob.outbox.invoke")?.status).toEqual({ code: 1 })
    expect(spans.find((span) => span.name === "bob.outbox.consume")?.events).toEqual([
      expect.objectContaining({
        name: "bob.decision.idempotency",
        attributes: expect.arrayContaining([
          { key: "bob.decision.code", value: { stringValue: "replay" } }
        ])
      })
    ])
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
      CORE_CALLER_SECRET: "c".repeat(64),
      ...telemetryBindings
    } as never)

    expect(outcome).toBe("done")
    expect(result).toMatchObject({
      outboxId,
      attemptId,
      state: "accepted",
      providerMessageHandle: "sendblue-handle"
    })
    expect(claimRequests[0]?.get("traceparent")).toMatch(
      /^00-018e6f654d557a1b8df44ee15ea1dba1-[0-9a-f]{16}-01$/
    )
    expect(providerRequests).toEqual([
      expect.objectContaining({
        status_callback: expect.stringMatching(
          /^https:\/\/bob\.example\/webhooks\/outbound\?outbox_id=.*&attempt_id=.*&correlation_id=018e6f65-4d55-7a1b-8df4-4ee15ea1dba1&traceparent=00-018e6f654d557a1b8df44ee15ea1dba1-[0-9a-f]{16}-01$/
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
      CORE_CALLER_SECRET: "c".repeat(64),
      ...telemetryBindings
    } as never)

    expect(outcome).toBe("done")
    expect(core.fetch).toHaveBeenCalledTimes(2)
  })

  it("marks the Core delivery-result client span failed after a non-success response", async () => {
    const exports: RequestInit[] = []
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input).endsWith("/v1/traces")) {
          if (init !== undefined) exports.push(init)
          return new Response(null, { status: 200 })
        }
        return Response.json({ message_handle: "sendblue-handle" })
      })
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
              correlationId,
              claimedAt: "2026-08-11T10:00:00.000Z"
            })
          : Response.json({ code: "unavailable" }, { status: 503 })
      )
    }
    const context = executionContext()

    const outcome = await processOutboundJob(
      { outboxId, correlationId },
      {
        CORE: core,
        DELIVERY_RESULT_QUEUE: {
          send: async () => Promise.reject(new Error("queue unavailable"))
        },
        SENDBLUE_API_KEY_ID: "key",
        SENDBLUE_API_SECRET_KEY: "secret",
        SENDBLUE_STATUS_CALLBACK_URL: "https://bob.example/webhooks/outbound",
        CORE_CALLER_SECRET: "c".repeat(64),
        ...telemetryBindings
      } as never,
      context.value
    )
    await context.drain()

    expect(outcome).toBe("retry")
    const spans = JSON.parse(String(exports[0]?.body)).resourceSpans[0].scopeSpans[0]
      .spans as ExportedSpan[]
    expect(spans.find((span) => span.name === "bob.delivery_result.invoke")?.status).toEqual({
      code: 2
    })
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
      CORE_CALLER_SECRET: "c".repeat(64),
      ...telemetryBindings
    } as never)

    expect(outcome).toBe("retry")
  })
})
