import { describe, expect, it, vi } from "vitest"

import { nodeTelemetrySink } from "../src/node.ts"

const span = {
  type: "workflow_span" as const,
  correlationId: "018e6f65-4d55-7a1b-8df4-4ee15ea1db9f",
  traceId: "11111111111111111111111111111111",
  spanId: "2222222222222222",
  parentSpanId: "3333333333333333",
  name: "model.run" as const,
  feature: "reminders" as const,
  workflow: "agent_turn" as const,
  status: "completed" as const,
  code: "ok" as const,
  durationMs: 25
}

describe("Node OpenTelemetry export", () => {
  it("exports a content-free OTLP HTTP span and keeps the typed JSON log", async () => {
    const requests: Array<{
      readonly input: RequestInfo | URL
      readonly init: RequestInit | undefined
    }> = []
    // SAFETY: This controlled test fixture matches the asserted contract used by this test.
    const request = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ input, init })
      return new Response(null, { status: 200 })
    }) as typeof fetch
    const lines: string[] = []
    const sink = nodeTelemetrySink({
      endpoint: "http://collector.example.invalid:4318",
      serviceName: "bob-agent",
      deploymentEnvironment: "prod",
      releaseSha: "f974ae0fc5b53ca1c233faa0dfd69e9f814cb25f",
      fetch: request,
      now: () => 1_000,
      write: (line) => lines.push(line)
    })

    await sink.emit(span)

    expect(lines).toEqual([JSON.stringify(span)])
    expect(requests).toHaveLength(1)
    expect(String(requests[0]?.input)).toBe("http://collector.example.invalid:4318/v1/traces")
    expect(requests[0]?.init).toMatchObject({
      method: "POST",
      headers: { "content-type": "application/json" }
    })
    // SAFETY: This controlled test fixture matches the asserted contract used by this test.
    const payload = JSON.parse(String(requests[0]?.init?.body)) as {
      resourceSpans: Array<{
        resource: {
          attributes: Array<{ key: string; value: { stringValue: string } }>
        }
        scopeSpans: Array<{
          spans: Array<{
            traceId: string
            spanId: string
            parentSpanId: string
            name: string
            kind: number
            startTimeUnixNano: string
            endTimeUnixNano: string
            status: { code: number }
            attributes: Array<{ key: string; value: { stringValue: string } }>
          }>
        }>
      }>
    }
    expect(payload.resourceSpans[0]?.resource.attributes).toEqual([
      { key: "service.name", value: { stringValue: "bob-agent" } },
      {
        key: "service.version",
        value: { stringValue: "f974ae0fc5b53ca1c233faa0dfd69e9f814cb25f" }
      },
      { key: "deployment.environment", value: { stringValue: "prod" } },
      { key: "deployment.environment.name", value: { stringValue: "prod" } },
      {
        key: "bob.release.sha",
        value: { stringValue: "f974ae0fc5b53ca1c233faa0dfd69e9f814cb25f" }
      }
    ])
    expect(payload.resourceSpans[0]?.scopeSpans[0]?.spans).toEqual([
      {
        traceId: span.traceId,
        spanId: span.spanId,
        parentSpanId: span.parentSpanId,
        name: span.name,
        kind: 1,
        startTimeUnixNano: "975000000",
        endTimeUnixNano: "1000000000",
        attributes: [
          { key: "bob.correlation_id", value: { stringValue: span.correlationId } },
          { key: "bob.trace_id", value: { stringValue: span.traceId } },
          { key: "bob.status", value: { stringValue: span.status } },
          { key: "bob.code", value: { stringValue: span.code } },
          { key: "bob.duration_ms", value: { intValue: "25" } },
          { key: "bob.feature", value: { stringValue: span.feature } },
          { key: "bob.workflow", value: { stringValue: span.workflow } }
        ],
        status: { code: 1 },
        flags: 1
      }
    ])
  })

  it("keeps the workflow available when the collector rejects a trace", async () => {
    const lines: string[] = []
    let body = ""
    const sink = nodeTelemetrySink({
      endpoint: "http://collector.example.invalid:4318",
      serviceName: "bob-agent",
      deploymentEnvironment: "prod",
      releaseSha: "f974ae0fc5b53ca1c233faa0dfd69e9f814cb25f",
      fetch: vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        body = String(init?.body)
        return new Response("private collector response", { status: 503 })
      }),
      write: (line) => lines.push(line)
    })

    expect(sink.emit({ ...span, status: "failed", code: "provider" })).toBeUndefined()
    expect(lines).toEqual([JSON.stringify({ ...span, status: "failed", code: "provider" })])
    expect(JSON.stringify({ lines, body })).not.toContain("private collector response")
    expect(JSON.parse(body).resourceSpans[0].scopeSpans[0].spans[0]).toMatchObject({
      status: { code: 2 },
      attributes: expect.arrayContaining([
        { key: "bob.status", value: { stringValue: "failed" } },
        { key: "bob.code", value: { stringValue: "provider" } }
      ])
    })
  })
})
