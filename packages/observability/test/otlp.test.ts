import { Effect } from "effect"
import { describe, expect, it, vi } from "vitest"

import type { SafeSpanRecord } from "../src/effect.ts"
import type { OtlpProcessorDiagnostic } from "../src/otlp.ts"

import { makeOtlpHttpSpanProcessor } from "../src/otlp.ts"

function span(index: number, sampled = true): SafeSpanRecord {
  return {
    name: "bob.inbound.process",
    traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
    spanId: index.toString(16).padStart(16, "0"),
    kind: "internal",
    sampled,
    startTimeUnixNano: BigInt(index),
    endTimeUnixNano: BigInt(index + 1),
    outcome: "completed",
    attributes: {
      "bob.correlation.id": "018e6f65-4d55-7a1b-8df4-4ee15ea1db9f",
      "bob.feature": "assistant",
      "bob.workflow": "inbound_message"
    },
    events: []
  }
}

describe("bounded OTLP span processing", () => {
  it("reports one closed diagnostic for a rejected HTTP batch", async () => {
    const diagnostics: OtlpProcessorDiagnostic[] = []
    const processor = makeOtlpHttpSpanProcessor({
      endpoint: "https://otel.example.test",
      serviceName: "bob-core",
      serviceVersion: "0123456789abcdef0123456789abcdef01234567",
      deploymentEnvironment: "test",
      fetch: vi.fn(async () => new Response(null, { status: 503 })) as typeof fetch,
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic)
    })

    processor.onEnd(span(1))
    processor.onEnd(span(2))
    await Effect.runPromise(processor.forceFlush)

    expect(diagnostics).toEqual([{ code: "http_5xx", count: 2 }])
  })

  it("cancels a rejected collector response body without reading it", async () => {
    const cancel = vi.fn()
    const diagnostics: OtlpProcessorDiagnostic[] = []
    const processor = makeOtlpHttpSpanProcessor({
      endpoint: "https://otel.example.test",
      serviceName: "bob-core",
      serviceVersion: "0123456789abcdef0123456789abcdef01234567",
      deploymentEnvironment: "test",
      fetch: vi.fn(
        async () =>
          new Response(new ReadableStream({ cancel }), {
            status: 403,
            headers: { "content-type": "text/html" }
          })
      ) as typeof fetch,
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic)
    })

    processor.onEnd(span(1))
    await Effect.runPromise(processor.forceFlush)

    expect(cancel).toHaveBeenCalledOnce()
    expect(diagnostics).toEqual([{ code: "http_4xx", count: 1 }])
  })

  it("reports the number of spans dropped by queue overflow", async () => {
    const diagnostics: OtlpProcessorDiagnostic[] = []
    const processor = makeOtlpHttpSpanProcessor({
      endpoint: "https://otel.example.test",
      serviceName: "bob-core",
      serviceVersion: "0123456789abcdef0123456789abcdef01234567",
      deploymentEnvironment: "test",
      maxQueueSize: 2,
      fetch: vi.fn(async () => new Response(null, { status: 200 })) as typeof fetch,
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic)
    })

    processor.onEnd(span(1))
    processor.onEnd(span(2))
    processor.onEnd(span(3))
    processor.onEnd(span(4))
    await Effect.runPromise(processor.forceFlush)

    expect(diagnostics).toEqual([{ code: "queue_overflow", count: 2 }])
  })

  it("reports spans dropped by an invalid collector endpoint", async () => {
    const diagnostics: OtlpProcessorDiagnostic[] = []
    const request = vi.fn()
    const processor = makeOtlpHttpSpanProcessor({
      endpoint: "not-a-url",
      serviceName: "bob-core",
      serviceVersion: "0123456789abcdef0123456789abcdef01234567",
      deploymentEnvironment: "test",
      fetch: request,
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic)
    })

    processor.onEnd(span(1))
    processor.onEnd(span(2))
    await Effect.runPromise(processor.forceFlush)

    expect(request).not.toHaveBeenCalled()
    expect(diagnostics).toEqual([{ code: "invalid_endpoint", count: 2 }])
  })

  it("drops spans when resource metadata is unsafe", async () => {
    const diagnostics: OtlpProcessorDiagnostic[] = []
    const request = vi.fn()
    const privateCanary = "private-service-+46700000000"
    const processor = makeOtlpHttpSpanProcessor({
      endpoint: "https://otel.example.test",
      serviceName: privateCanary,
      serviceVersion: "0123456789abcdef0123456789abcdef01234567",
      deploymentEnvironment: "test",
      fetch: request,
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic)
    })

    processor.onEnd(span(1))
    processor.onEnd(span(2))
    await Effect.runPromise(processor.forceFlush)

    expect(request).not.toHaveBeenCalled()
    expect(diagnostics).toEqual([{ code: "invalid_configuration", count: 2 }])
    expect(JSON.stringify(diagnostics)).not.toContain(privateCanary)
  })

  it.each([
    {
      label: "release SHA",
      serviceVersion: "0123456789ABCDEF0123456789ABCDEF01234567",
      deploymentEnvironment: "test"
    },
    {
      label: "deployment environment",
      serviceVersion: "0123456789abcdef0123456789abcdef01234567",
      deploymentEnvironment: "production"
    }
  ])("drops spans with an invalid $label", async ({ serviceVersion, deploymentEnvironment }) => {
    const diagnostics: OtlpProcessorDiagnostic[] = []
    const request = vi.fn()
    const processor = makeOtlpHttpSpanProcessor({
      endpoint: "https://otel.example.test",
      serviceName: "bob-core",
      serviceVersion,
      deploymentEnvironment,
      fetch: request,
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic)
    })

    processor.onEnd(span(1))
    await Effect.runPromise(processor.forceFlush)

    expect(request).not.toHaveBeenCalled()
    expect(diagnostics).toEqual([{ code: "invalid_configuration", count: 1 }])
  })

  it("reports a bounded collector timeout without raw error data", async () => {
    const diagnostics: OtlpProcessorDiagnostic[] = []
    const privateError = "private-collector-timeout-response"
    const processor = makeOtlpHttpSpanProcessor({
      endpoint: "https://otel.example.test",
      serviceName: "bob-core",
      serviceVersion: "0123456789abcdef0123456789abcdef01234567",
      deploymentEnvironment: "test",
      timeoutMs: 5,
      fetch: vi.fn(
        async (_input: RequestInfo | URL, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(new Error(privateError)), {
              once: true
            })
          })
      ) as typeof fetch,
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic)
    })

    processor.onEnd(span(1))
    await Effect.runPromise(processor.forceFlush)

    expect(diagnostics).toEqual([{ code: "export_timeout", count: 1 }])
    expect(JSON.stringify(diagnostics)).not.toContain(privateError)
  })

  it("reports a network failure without raw error data", async () => {
    const diagnostics: OtlpProcessorDiagnostic[] = []
    const privateError = "private-network-response"
    const processor = makeOtlpHttpSpanProcessor({
      endpoint: "https://otel.example.test",
      serviceName: "bob-core",
      serviceVersion: "0123456789abcdef0123456789abcdef01234567",
      deploymentEnvironment: "test",
      fetch: vi.fn(async () => {
        throw new Error(privateError)
      }) as typeof fetch,
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic)
    })

    processor.onEnd(span(1))
    await Effect.runPromise(processor.forceFlush)

    expect(diagnostics).toEqual([{ code: "network_error", count: 1 }])
    expect(JSON.stringify(diagnostics)).not.toContain(privateError)
  })

  it("writes a content-free diagnostic to stdout when no callback is configured", async () => {
    const privateError = "private-default-diagnostic-response"
    const write = vi.spyOn(console, "log").mockImplementation(() => undefined)
    try {
      const processor = makeOtlpHttpSpanProcessor({
        endpoint: "https://otel.example.test",
        serviceName: "bob-core",
        serviceVersion: "0123456789abcdef0123456789abcdef01234567",
        deploymentEnvironment: "test",
        fetch: vi.fn(async () => {
          throw new Error(privateError)
        }) as typeof fetch
      })

      processor.onEnd(span(1))
      await Effect.runPromise(processor.forceFlush)

      expect(write).toHaveBeenCalledWith(
        JSON.stringify({ type: "otel_export", code: "network_error", count: 1 })
      )
      expect(JSON.stringify(write.mock.calls)).not.toContain(privateError)
    } finally {
      write.mockRestore()
    }
  })

  it("contains diagnostic callback failures", async () => {
    const processor = makeOtlpHttpSpanProcessor({
      endpoint: "not-a-url",
      serviceName: "bob-core",
      serviceVersion: "0123456789abcdef0123456789abcdef01234567",
      deploymentEnvironment: "test",
      onDiagnostic: () => {
        throw new Error("diagnostic callback failed")
      }
    })

    processor.onEnd(span(1))

    await expect(Effect.runPromise(processor.forceFlush)).resolves.toBeUndefined()
  })

  it("stops without exporting when shutdown flush is disabled", async () => {
    const request = vi.fn(async () => new Response(null, { status: 200 })) as typeof fetch
    const processor = makeOtlpHttpSpanProcessor({
      endpoint: "https://otel.example.test",
      serviceName: "bob-core",
      serviceVersion: "0123456789abcdef0123456789abcdef01234567",
      deploymentEnvironment: "test",
      fetch: request,
      flushOnShutdown: false
    })

    processor.onEnd(span(1))
    await Effect.runPromise(processor.shutdown)
    processor.onEnd(span(2))
    await Effect.runPromise(processor.forceFlush)

    expect(request).not.toHaveBeenCalled()
  })

  it("reports an export failure during shutdown and remains fail-open", async () => {
    const diagnostics: OtlpProcessorDiagnostic[] = []
    const processor = makeOtlpHttpSpanProcessor({
      endpoint: "https://otel.example.test",
      serviceName: "bob-core",
      serviceVersion: "0123456789abcdef0123456789abcdef01234567",
      deploymentEnvironment: "test",
      fetch: vi.fn(async () => {
        throw new Error("private-shutdown-response")
      }) as typeof fetch,
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic)
    })

    processor.onEnd(span(1))

    await expect(Effect.runPromise(processor.shutdown)).resolves.toBeUndefined()
    expect(diagnostics).toEqual([{ code: "network_error", count: 1 }])
  })

  it("drops overflow and unsampled spans, then flushes bounded batches", async () => {
    const batches: string[][] = []
    const request = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        resourceSpans: Array<{ scopeSpans: Array<{ spans: Array<{ spanId: string }> }> }>
      }
      batches.push(body.resourceSpans[0]?.scopeSpans[0]?.spans.map((item) => item.spanId) ?? [])
      return new Response(null, { status: 200 })
    }) as typeof fetch
    const processor = makeOtlpHttpSpanProcessor({
      endpoint: "https://otel.example.test",
      serviceName: "bob-core",
      serviceVersion: "0123456789abcdef0123456789abcdef01234567",
      deploymentEnvironment: "test",
      maxQueueSize: 3,
      maxBatchSize: 2,
      fetch: request
    })

    processor.onEnd(span(1))
    processor.onEnd(span(2, false))
    processor.onEnd(span(3))
    processor.onEnd(span(4))
    processor.onEnd(span(5))
    await Effect.runPromise(processor.forceFlush)

    expect(batches).toEqual([["0000000000000001", "0000000000000003"], ["0000000000000004"]])
  })
})
