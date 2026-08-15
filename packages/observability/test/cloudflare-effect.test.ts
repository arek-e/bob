import { Effect } from "effect"
import { describe, expect, it, vi } from "vitest"

import {
  cloudflareTelemetryLayer,
  flushCloudflareTelemetry,
  makeCloudflareSpanProcessor
} from "../src/cloudflare.ts"
import { emitHealth, withBobSpan } from "../src/effect.ts"
import { externalParentFromTraceparent } from "../src/propagation.ts"

const correlationId = "018e6f65-4d55-7a1b-8df4-4ee15ea1db9f"

describe("Cloudflare Effect telemetry", () => {
  it("batches one invocation into one safe OTLP trace request", async () => {
    const requests: Array<{ readonly url: string; readonly init?: RequestInit }> = []
    // SAFETY: This controlled test fixture matches the asserted contract used by this test.
    const request = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push(init === undefined ? { url: String(input) } : { url: String(input), init })
      return new Response(null, { status: 200 })
    }) as typeof fetch
    const processor = makeCloudflareSpanProcessor({
      endpoint: "https://otel.example.test",
      serviceName: "bob-sendblue-ingress",
      serviceVersion: "0123456789abcdef0123456789abcdef01234567",
      deploymentEnvironment: "test",
      fetch: request
    })
    const layer = cloudflareTelemetryLayer({ processor, writeHealth: () => undefined })
    const parent = externalParentFromTraceparent(
      "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"
    )!

    const program = withBobSpan(
      {
        name: "bob.inbound.accept",
        correlationId,
        feature: "assistant"
      },
      withBobSpan(
        {
          name: "bob.inbound.persist",
          correlationId,
          feature: "assistant"
        },
        Effect.void
      )
    ).pipe(Effect.withParentSpan(parent), Effect.provide(layer))

    await Effect.runPromise(program)
    await Effect.runPromise(flushCloudflareTelemetry(processor))

    expect(requests).toHaveLength(1)
    expect(requests[0]?.url).toBe("https://otel.example.test/v1/traces")
    expect(requests[0]?.init?.method).toBe("POST")
    expect(new Headers(requests[0]?.init?.headers).get("content-type")).toBe("application/json")
    // SAFETY: This controlled test fixture matches the asserted contract used by this test.
    const payload = JSON.parse(String(requests[0]?.init?.body)) as {
      resourceSpans: Array<{
        resource: { attributes: Array<{ key: string; value: { stringValue?: string } }> }
        scopeSpans: Array<{
          spans: Array<{
            name: string
            traceId: string
            spanId: string
            parentSpanId?: string
            kind: number
            flags: number
            status: { code: number }
          }>
        }>
      }>
    }
    expect(payload.resourceSpans[0]?.resource.attributes).toEqual(
      expect.arrayContaining([
        { key: "service.name", value: { stringValue: "bob-sendblue-ingress" } },
        {
          key: "service.version",
          value: { stringValue: "0123456789abcdef0123456789abcdef01234567" }
        },
        { key: "deployment.environment.name", value: { stringValue: "test" } }
      ])
    )
    const spans = payload.resourceSpans[0]?.scopeSpans[0]?.spans ?? []
    expect(spans).toHaveLength(2)
    expect(spans.map((span) => span.name)).toEqual(["bob.inbound.persist", "bob.inbound.accept"])
    expect(spans[1]).toMatchObject({
      traceId: parent.traceId,
      parentSpanId: parent.spanId,
      kind: 2,
      flags: 1,
      status: { code: 1 }
    })
    expect(spans[0]).toMatchObject({
      traceId: parent.traceId,
      parentSpanId: spans[1]?.spanId,
      kind: 1,
      flags: 1,
      status: { code: 1 }
    })
  })

  it("keeps the workflow successful when an authenticated collector request fails", async () => {
    const privateCanary = "private-collector-response"
    const requests: RequestInit[] = []
    // SAFETY: This controlled test fixture matches the asserted contract used by this test.
    const request = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init !== undefined) requests.push(init)
      throw new Error(privateCanary)
    }) as typeof fetch
    const processor = makeCloudflareSpanProcessor({
      endpoint: "https://otel.example.test",
      serviceName: "bob-core",
      serviceVersion: "0123456789abcdef0123456789abcdef01234567",
      deploymentEnvironment: "test",
      headers: {
        "CF-Access-Client-Id": "client-id",
        "CF-Access-Client-Secret": "client-secret"
      },
      fetch: request
    })
    const layer = cloudflareTelemetryLayer({ processor, writeHealth: () => undefined })

    await Effect.runPromise(
      withBobSpan(
        { name: "bob.inbound.process", correlationId, feature: "assistant" },
        Effect.succeed("workflow-result")
      ).pipe(Effect.provide(layer))
    )
    await expect(Effect.runPromise(flushCloudflareTelemetry(processor))).resolves.toBeUndefined()
    await expect(Effect.runPromise(flushCloudflareTelemetry(processor))).resolves.toBeUndefined()

    expect(requests).toHaveLength(1)
    const headers = new Headers(requests[0]?.headers)
    expect(headers.get("cf-access-client-id")).toBe("client-id")
    expect(headers.get("cf-access-client-secret")).toBe("client-secret")
    expect(String(requests[0]?.body)).not.toContain(privateCanary)
  })

  it("keeps the workflow successful when the health writer fails", async () => {
    const processor = makeCloudflareSpanProcessor({
      endpoint: "https://otel.example.test",
      serviceName: "bob-core",
      serviceVersion: "0123456789abcdef0123456789abcdef01234567",
      deploymentEnvironment: "test",
      // SAFETY: This controlled test fixture matches the asserted contract used by this test.
      fetch: vi.fn(async () => new Response(null, { status: 200 })) as typeof fetch
    })
    const layer = cloudflareTelemetryLayer({
      processor,
      writeHealth: () => {
        throw new Error("collector unavailable")
      }
    })

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* emitHealth({
          type: "provider_auth",
          correlationId,
          status: "configured",
          code: "configured"
        })
        return "workflow-result"
      }).pipe(Effect.provide(layer))
    )

    expect(result).toBe("workflow-result")
  })
})
