import { parseTraceparent } from "@bob/observability"
import { afterEach, describe, expect, it, vi } from "vitest"

import { handleIngressHttp } from "../runtime.ts"

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

const releaseSha = "0123456789abcdef0123456789abcdef01234567"

interface ExportedSpan {
  readonly name: string
  readonly traceId: string
  readonly spanId: string
  readonly parentSpanId?: string
  readonly status: { readonly code: number }
  readonly attributes: Array<{ readonly key: string; readonly value: unknown }>
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
    // SAFETY: This controlled test fixture matches the asserted contract used by this test.
    value: {
      waitUntil(promise: Promise<unknown>) {
        pending.push(promise)
      },
      passThroughOnException() {}
    } as never,
    drain: () => Promise.all(pending)
  }
}

function bindings(
  queueSend = vi.fn().mockResolvedValue(undefined),
  mediaFetch = vi.fn(async () => new Response(null, { status: 500 }))
) {
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
      MEDIA: { fetch: mediaFetch },
      INBOUND_QUEUE: { send: queueSend, sendBatch: vi.fn().mockResolvedValue(undefined) },
      SENDBLUE_ACCOUNT_ID: "account",
      SENDBLUE_LINE_ID: "line",
      SENDBLUE_WEBHOOK_SIGNING_SECRET: "s".repeat(64),
      SENDBLUE_FROM_NUMBER: "+46711111111",
      CORE_CALLER_SECRET: "c".repeat(64),
      SENDBLUE_MEDIA_HOSTS: "media.example.test",
      OTEL_EXPORTER_OTLP_ENDPOINT: "https://otel.example.test",
      BOB_RELEASE_SHA: releaseSha
    },
    coreFetch,
    queueSend,
    mediaFetch
  }
}

function request(secret?: string, body: typeof payload = payload) {
  const headers = new Headers({ "content-type": "application/json" })
  if (secret !== undefined) headers.set("sb-signing-secret", secret)
  return new Request("https://bob.example/webhooks/receive", {
    method: "POST",
    headers,
    body: JSON.stringify(body)
  })
}

describe("Sendblue ingress", () => {
  it("stores an image before it publishes an image-only message", async () => {
    const image = Uint8Array.from([0x89, 0x50, 0x4e, 0x47])
    const target = bindings(
      undefined,
      vi.fn(
        async () =>
          new Response(image, {
            headers: { "content-type": "image/png", "content-length": String(image.byteLength) }
          })
      )
    )
    target.coreFetch.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith("/internal/inbound")) {
        return Response.json({
          eventId: "018e6f65-4d55-7a1b-8df4-4ee15ea1db9f",
          duplicate: false,
          shouldEnqueue: true,
          pendingAttachmentOrdinals: [0]
        })
      }
      return Response.json({ ok: true })
    })
    const body = {
      ...payload,
      content: "",
      media_url: "https://media.example.test/image.png"
    }

    const result = await handleIngressHttp(request("s".repeat(64), body), target.value)

    expect(result.status).toBe(202)
    expect(target.mediaFetch).toHaveBeenCalledOnce()
    expect(String(target.coreFetch.mock.calls[1]?.[0])).toContain("/attachments/0")
    expect(target.queueSend).toHaveBeenCalledOnce()
    expect(String(target.coreFetch.mock.calls[0]?.[1]?.body)).not.toContain(body.media_url)
  })

  it("exports and propagates one safe inbound trace after durable acceptance", async () => {
    const health: string[] = []
    vi.spyOn(console, "log").mockImplementation((line) => health.push(String(line)))
    const exports: RequestInit[] = []
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        if (init !== undefined) exports.push(init)
        return new Response(null, { status: 200 })
      })
    )
    const target = bindings()
    const context = executionContext()
    const parent = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"
    const inbound = request("s".repeat(64))
    inbound.headers.set("traceparent", parent)

    // SAFETY: This controlled test fixture matches the asserted contract used by this test.
    const result = await handleIngressHttp(inbound, target.value as never, context.value)
    await context.drain()

    expect(result.status).toBe(202)
    const coreHeaders = new Headers(target.coreFetch.mock.calls[0]?.[1]?.headers)
    expect(parseTraceparent(coreHeaders.get("traceparent"))?.traceId).toBe(
      "4bf92f3577b34da6a3ce929d0e0e4736"
    )
    // SAFETY: This controlled test fixture matches the asserted contract used by this test.
    const persisted = JSON.parse(String(target.coreFetch.mock.calls[0]?.[1]?.body)) as {
      correlationId: string
    }
    expect(target.queueSend).toHaveBeenCalledWith(
      expect.objectContaining({
        correlationId: persisted.correlationId,
        traceparent: expect.stringMatching(/^00-4bf92f3577b34da6a3ce929d0e0e4736-[0-9a-f]{16}-01$/)
      })
    )
    expect(exports).toHaveLength(1)
    const body = String(exports[0]?.body)
    // SAFETY: This controlled test fixture matches the asserted contract used by this test.
    const spans = JSON.parse(body).resourceSpans[0].scopeSpans[0].spans as ExportedSpan[]
    expect(spans.map((span) => span.name)).toEqual([
      "bob.inbound.invoke",
      "bob.inbound.publish",
      "bob.inbound.confirm",
      "bob.webhook.receive"
    ])
    expect(spans.every((span) => span.traceId === "4bf92f3577b34da6a3ce929d0e0e4736")).toBe(true)
    expect(spans.slice(0, 3).map((span) => span.parentSpanId)).toEqual([
      spans[3]?.spanId,
      spans[3]?.spanId,
      spans[3]?.spanId
    ])
    expect(spans[3]?.parentSpanId).toBe(parseTraceparent(parent)?.spanId)
    expectTraceparentFrom(coreHeaders.get("traceparent"), spans[0])
    // SAFETY: This controlled test fixture matches the asserted contract used by this test.
    const queued = target.queueSend.mock.calls[0]?.[0] as { readonly traceparent?: string }
    expectTraceparentFrom(queued.traceparent, spans[1])
    const markedHeaders = new Headers(target.coreFetch.mock.calls[1]?.[1]?.headers)
    expect(markedHeaders.get("x-bob-correlation-id")).toBe(persisted.correlationId)
    expectTraceparentFrom(markedHeaders.get("traceparent"), spans[2])
    expect(spans.at(-1)?.events).toEqual([
      expect.objectContaining({
        name: "bob.decision.idempotency",
        attributes: expect.arrayContaining([
          { key: "bob.decision.code", value: { stringValue: "new" } }
        ])
      })
    ])
    expect(body).not.toContain(payload.content)
    expect(body).not.toContain(payload.from_number)
    expect(body).not.toContain("otel-secret")
    expect(health.map((line) => JSON.parse(line))).toEqual([
      expect.objectContaining({
        type: "webhook",
        status: "accepted",
        code: "accepted",
        providerIngressDelayMs: expect.any(Number)
      })
    ])
    expect(spans.at(-1)?.attributes).toEqual(
      expect.arrayContaining([expect.objectContaining({ key: "bob.provider.ingress_delay_ms" })])
    )
    expect(health.join("\n")).not.toContain(payload.content)
    expect(health.join("\n")).not.toContain(payload.from_number)
  })

  it("does not count a recovery replay as live ingress delay", async () => {
    const health: string[] = []
    vi.spyOn(console, "log").mockImplementation((line) => health.push(String(line)))
    const target = bindings()
    const replay = request("s".repeat(64))
    replay.headers.set("x-bob-ingress-source", "recovery_replay")

    // SAFETY: This controlled fixture contains the bindings required by the ingress Effect Layer.
    const result = await handleIngressHttp(replay, target.value as never)

    expect(result.status).toBe(202)
    const event = health.map((line) => JSON.parse(line))[0]
    expect(event).toMatchObject({
      type: "webhook",
      providerIngressSource: "recovery_replay",
      providerEventAgeMs: expect.any(Number)
    })
    expect(event).not.toHaveProperty("providerIngressDelayMs")
  })

  it("accepts a valid webhook when all telemetry bindings are missing", async () => {
    const telemetryFetch = vi.fn(async () => new Response(null, { status: 200 }))
    vi.stubGlobal("fetch", telemetryFetch)
    const target = bindings()
    // SAFETY: This controlled test fixture matches the asserted contract used by this test.
    const value: Partial<typeof target.value> = { ...target.value }
    delete value.OTEL_EXPORTER_OTLP_ENDPOINT
    delete value.BOB_RELEASE_SHA
    const context = executionContext()

    // SAFETY: This controlled test fixture matches the asserted contract used by this test.
    const result = await handleIngressHttp(request("s".repeat(64)), value as never, context.value)
    await context.drain()

    expect(result.status).toBe(202)
    expect(target.coreFetch).toHaveBeenCalledTimes(2)
    expect(target.queueSend).toHaveBeenCalledOnce()
    expect(telemetryFetch).not.toHaveBeenCalled()
  })

  it.each([
    ["OTLP endpoint", { OTEL_EXPORTER_OTLP_ENDPOINT: "not a URL" }],
    ["release SHA", { BOB_RELEASE_SHA: "not-a-release" }]
  ])("accepts a valid webhook when the %s is malformed", async (_name, override) => {
    const telemetryFetch = vi.fn(async () => new Response(null, { status: 200 }))
    vi.stubGlobal("fetch", telemetryFetch)
    const target = bindings()
    const context = executionContext()

    const result = await handleIngressHttp(
      request("s".repeat(64)),
      // SAFETY: This controlled test fixture matches the asserted contract used by this test.
      { ...target.value, ...override } as never,
      context.value
    )
    await context.drain()

    expect(result.status).toBe(202)
    expect(target.coreFetch).toHaveBeenCalledTimes(2)
    expect(target.queueSend).toHaveBeenCalledOnce()
    expect(telemetryFetch).not.toHaveBeenCalled()
  })

  it("keeps application binding validation strict", async () => {
    const target = bindings()
    // SAFETY: This controlled test fixture matches the asserted contract used by this test.
    const value: Partial<typeof target.value> = { ...target.value }
    delete value.SENDBLUE_WEBHOOK_SIGNING_SECRET

    // SAFETY: This controlled test fixture matches the asserted contract used by this test.
    await expect(handleIngressHttp(request("s".repeat(64)), value as never)).rejects.toThrow()
    expect(target.coreFetch).not.toHaveBeenCalled()
    expect(target.queueSend).not.toHaveBeenCalled()
  })

  it("rejects a missing or wrong secret before any durable write", async () => {
    const target = bindings()
    // SAFETY: This controlled test fixture matches the asserted contract used by this test.
    expect((await handleIngressHttp(request(), target.value as never)).status).toBe(401)
    // SAFETY: This controlled test fixture matches the asserted contract used by this test.
    expect((await handleIngressHttp(request("wrong"), target.value as never)).status).toBe(401)
    expect(target.coreFetch).not.toHaveBeenCalled()
  })

  it("forwards an unknown sender for trusted Core owner resolution", async () => {
    const target = bindings()
    const bad = { ...payload, from_number: "+46799999999", number: "+46799999999" }
    const response = await handleIngressHttp(
      new Request("https://bob.example/webhooks/receive", {
        method: "POST",
        headers: { "sb-signing-secret": "s".repeat(64) },
        body: JSON.stringify(bad)
      }),
      // SAFETY: This controlled test fixture matches the asserted contract used by this test.
      target.value as never
    )
    expect(response.status).toBe(202)
    expect(target.coreFetch).toHaveBeenCalledTimes(2)
  })

  it("rejects a sender when Core has no owner binding", async () => {
    const target = bindings()
    target.coreFetch.mockResolvedValueOnce(Response.json({ code: "not_allowed" }, { status: 403 }))
    const result = await handleIngressHttp(
      request("s".repeat(64), {
        ...payload,
        from_number: "+46799999999",
        number: "+46799999999"
      }),
      // SAFETY: This controlled test fixture matches the asserted contract used by this test.
      target.value as never
    )
    expect(result.status).toBe(403)
    expect(target.queueSend).not.toHaveBeenCalled()
  })

  it("accepts an uncorrelated status callback for the managed line", async () => {
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
      // SAFETY: This controlled test fixture matches the asserted contract used by this test.
      target.value as never
    )
    expect(response.status).toBe(202)
    expect(target.coreFetch).not.toHaveBeenCalled()
  })

  it("acknowledges an uncorrelated account status without calling Core", async () => {
    const target = bindings()
    const result = await handleIngressHttp(
      new Request("https://bob.example/webhooks/outbound", {
        method: "POST",
        headers: { "sb-signing-secret": "s".repeat(64) },
        body: JSON.stringify({
          ...payload,
          is_outbound: true,
          status: "DELIVERED",
          from_number: "+46711111111",
          to_number: "+46700000000"
        })
      }),
      // SAFETY: This controlled test fixture matches the asserted contract used by this test.
      target.value as never
    )

    expect(result.status).toBe(202)
    await expect(result.json()).resolves.toEqual({ code: "ignored" })
    expect(target.coreFetch).not.toHaveBeenCalled()
  })

  it("forwards an uncorrelated opt-out status to Core", async () => {
    const target = bindings()
    const result = await handleIngressHttp(
      new Request("https://bob.example/webhooks/outbound", {
        method: "POST",
        headers: { "sb-signing-secret": "s".repeat(64) },
        body: JSON.stringify({
          ...payload,
          is_outbound: true,
          status: "OPTED_OUT",
          opted_out: true,
          from_number: "+46711111111",
          to_number: "+46700000000"
        })
      }),
      // SAFETY: This controlled test fixture matches the asserted contract used by this test.
      target.value as never
    )

    expect(result.status).toBe(202)
    expect(target.coreFetch).toHaveBeenCalledOnce()
    expect(JSON.parse(String(target.coreFetch.mock.calls[0]?.[1]?.body))).toMatchObject({
      providerOptedOut: true,
      status: "opted_out"
    })
  })

  it("continues the provider trace through a status callback", async () => {
    const exports: RequestInit[] = []
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        if (init !== undefined) exports.push(init)
        return new Response(null, { status: 200 })
      })
    )
    const target = bindings()
    const context = executionContext()
    const traceparent = "00-018e6f654d557a1b8df44ee15ea1dba1-1111111111111111-01"
    const correlationId = "018e6f65-4d55-7a1b-8df4-4ee15ea1dba2"
    const response = await handleIngressHttp(
      new Request(
        `https://bob.example/webhooks/outbound?o=018e6f65-4d55-7a1b-8df4-4ee15ea1db9f&a=018e6f65-4d55-7a1b-8df4-4ee15ea1dba0&c=${correlationId}&t=${encodeURIComponent(traceparent)}`,
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
      // SAFETY: This controlled test fixture matches the asserted contract used by this test.
      target.value as never,
      context.value
    )
    await context.drain()
    expect(response.status).toBe(202)
    const forwarded = new Headers(target.coreFetch.mock.calls[0]?.[1]?.headers)
    expect(forwarded.get("x-bob-correlation-id")).toBe(correlationId)
    expect(parseTraceparent(forwarded.get("traceparent"))?.traceId).toBe(
      "018e6f654d557a1b8df44ee15ea1dba1"
    )
    expect(JSON.parse(String(target.coreFetch.mock.calls[0]?.[1]?.body))).toMatchObject({
      outboxId: "018e6f65-4d55-7a1b-8df4-4ee15ea1db9f",
      attemptId: "018e6f65-4d55-7a1b-8df4-4ee15ea1dba0",
      correlationId
    })
    expect(exports).toHaveLength(1)
    const body = String(exports[0]?.body)
    // SAFETY: This controlled test fixture matches the asserted contract used by this test.
    const spans = JSON.parse(body).resourceSpans[0].scopeSpans[0].spans as ExportedSpan[]
    expect(spans.map((span) => span.name)).toEqual([
      "bob.delivery_result.invoke",
      "bob.provider.status"
    ])
    expect(spans[0]?.parentSpanId).toBe(spans[1]?.spanId)
    expect(spans[1]?.parentSpanId).toBe(parseTraceparent(traceparent)?.spanId)
    expect(spans[1]?.attributes).toEqual(
      expect.arrayContaining([expect.objectContaining({ key: "bob.provider.status_age_ms" })])
    )
    expectTraceparentFrom(forwarded.get("traceparent"), spans[0])
    expect(body).not.toContain(payload.to_number)
    expect(body).not.toContain(payload.content)
  })

  it("accepts the existing long status callback keys", async () => {
    const target = bindings()
    const callbackCorrelationId = "018e6f65-4d55-7a1b-8df4-4ee15ea1dba2"

    const result = await handleIngressHttp(
      new Request(
        `https://bob.example/webhooks/outbound?outbox_id=018e6f65-4d55-7a1b-8df4-4ee15ea1db9f&attempt_id=018e6f65-4d55-7a1b-8df4-4ee15ea1dba0&correlation_id=${callbackCorrelationId}`,
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
      // SAFETY: This controlled test fixture matches the asserted contract used by this test.
      target.value as never
    )

    expect(result.status).toBe(202)
    expect(JSON.parse(String(target.coreFetch.mock.calls[0]?.[1]?.body))).toMatchObject({
      outboxId: "018e6f65-4d55-7a1b-8df4-4ee15ea1db9f",
      attemptId: "018e6f65-4d55-7a1b-8df4-4ee15ea1dba0",
      correlationId: callbackCorrelationId
    })
  })

  it("marks the Core delivery-result client span failed after a non-success response", async () => {
    const exports: RequestInit[] = []
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        if (init !== undefined) exports.push(init)
        return new Response(null, { status: 200 })
      })
    )
    const target = bindings()
    target.coreFetch.mockResolvedValueOnce(Response.json({ code: "unavailable" }, { status: 503 }))
    const context = executionContext()
    const callbackCorrelationId = "018e6f65-4d55-7a1b-8df4-4ee15ea1dba2"

    const result = await handleIngressHttp(
      new Request(
        `https://bob.example/webhooks/outbound?outbox_id=018e6f65-4d55-7a1b-8df4-4ee15ea1db9f&attempt_id=018e6f65-4d55-7a1b-8df4-4ee15ea1dba0&correlation_id=${callbackCorrelationId}`,
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
      // SAFETY: This controlled test fixture matches the asserted contract used by this test.
      target.value as never,
      context.value
    )
    await context.drain()

    expect(result.status).toBe(503)
    // SAFETY: This controlled test fixture matches the asserted contract used by this test.
    const spans = JSON.parse(String(exports[0]?.body)).resourceSpans[0].scopeSpans[0]
      .spans as ExportedSpan[]
    expect(spans.find((span) => span.name === "bob.delivery_result.invoke")?.status).toEqual({
      code: 2
    })
  })

  it("returns 503 after the durable write when Queue publication fails", async () => {
    const exports: RequestInit[] = []
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        if (init !== undefined) exports.push(init)
        return new Response(null, { status: 200 })
      })
    )
    const queueSend = vi.fn().mockRejectedValue(new Error("queue down"))
    const target = bindings(queueSend)
    const context = executionContext()
    const response = await handleIngressHttp(
      request("s".repeat(64)),
      // SAFETY: This controlled test fixture matches the asserted contract used by this test.
      target.value as never,
      context.value
    )
    await context.drain()
    expect(response.status).toBe(503)
    expect(target.coreFetch).toHaveBeenCalledOnce()
    expect(queueSend).toHaveBeenCalledOnce()
    // SAFETY: This controlled test fixture matches the asserted contract used by this test.
    const spans = JSON.parse(String(exports[0]?.body)).resourceSpans[0].scopeSpans[0]
      .spans as Array<{ name: string; status: { code: number } }>
    expect(spans.find((span) => span.name === "bob.inbound.publish")?.status).toEqual({ code: 2 })
    expect(spans.find((span) => span.name === "bob.webhook.receive")?.status).toEqual({ code: 2 })
  })

  it("marks the Core inbound client span failed after a non-success response", async () => {
    const exports: RequestInit[] = []
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        if (init !== undefined) exports.push(init)
        return new Response(null, { status: 200 })
      })
    )
    const target = bindings()
    target.coreFetch.mockResolvedValueOnce(Response.json({ code: "unavailable" }, { status: 503 }))
    const context = executionContext()

    const result = await handleIngressHttp(
      request("s".repeat(64)),
      // SAFETY: This controlled test fixture matches the asserted contract used by this test.
      target.value as never,
      context.value
    )
    await context.drain()

    expect(result.status).toBe(503)
    // SAFETY: This controlled test fixture matches the asserted contract used by this test.
    const spans = JSON.parse(String(exports[0]?.body)).resourceSpans[0].scopeSpans[0]
      .spans as ExportedSpan[]
    expect(spans.find((span) => span.name === "bob.inbound.invoke")?.status).toEqual({ code: 2 })
  })

  it("marks the Core inbound confirmation span failed after a non-success response", async () => {
    const exports: RequestInit[] = []
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        if (init !== undefined) exports.push(init)
        return new Response(null, { status: 200 })
      })
    )
    const target = bindings()
    target.coreFetch
      .mockResolvedValueOnce(
        Response.json({
          eventId: "018e6f65-4d55-7a1b-8df4-4ee15ea1db9f",
          duplicate: false,
          shouldEnqueue: true
        })
      )
      .mockResolvedValueOnce(Response.json({ code: "unavailable" }, { status: 503 }))
    const context = executionContext()

    const result = await handleIngressHttp(
      request("s".repeat(64)),
      // SAFETY: This controlled test fixture matches the asserted contract used by this test.
      target.value as never,
      context.value
    )
    await context.drain()

    expect(result.status).toBe(503)
    // SAFETY: This controlled test fixture matches the asserted contract used by this test.
    const spans = JSON.parse(String(exports[0]?.body)).resourceSpans[0].scopeSpans[0]
      .spans as ExportedSpan[]
    expect(spans.find((span) => span.name === "bob.inbound.confirm")?.status).toEqual({ code: 2 })
  })

  it("publishes only opaque identifiers and trace context", async () => {
    const target = bindings()
    // SAFETY: This controlled test fixture matches the asserted contract used by this test.
    const response = await handleIngressHttp(request("s".repeat(64)), target.value as never)
    expect(response.status).toBe(202)
    expect(target.queueSend).toHaveBeenCalledWith(
      expect.objectContaining({
        eventId: "018e6f65-4d55-7a1b-8df4-4ee15ea1db9f",
        correlationId: expect.stringMatching(
          /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
        ),
        enqueuedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
        traceparent: expect.stringMatching(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/)
      })
    )
  })

  it("rejects an oversized webhook body", async () => {
    const target = bindings()
    const oversized = request("s".repeat(64))
    oversized.headers.set("content-length", String(16 * 1024 + 1))

    const response = await handleIngressHttp(
      oversized,
      // SAFETY: This controlled test fixture matches the asserted contract used by this test.
      target.value as never
    )

    expect(response.status).toBe(413)
    expect(await response.json()).toEqual({ code: "body_too_large" })
    expect(target.coreFetch).not.toHaveBeenCalled()
  })
})
