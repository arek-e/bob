import { Effect } from "effect"
import { describe, expect, it, vi } from "vitest"

import { flushTelemetry, withBobSpan } from "../src/effect.ts"
import { nodeTelemetryLayer } from "../src/node.ts"

const correlationId = "018e6f65-4d55-7a1b-8df4-4ee15ea1db9f"
const releaseSha = "0123456789abcdef0123456789abcdef01234567"

describe("Node Effect telemetry", () => {
  it("flushes safe Effect spans as one OTLP HTTP batch", async () => {
    const token = "collector-private-token"
    const requests: Array<{
      readonly url: string
      readonly body: string
      readonly headers: Headers
    }> = []
    const request = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({
        url: String(input),
        body: String(init?.body),
        headers: new Headers(init?.headers)
      })
      return new Response(null, { status: 200 })
    }) as typeof fetch
    const layer = nodeTelemetryLayer({
      endpoint: "http://collector.example.invalid:4318",
      serviceName: "bob-agent",
      serviceVersion: releaseSha,
      deploymentEnvironment: "prod",
      headers: { authorization: `Bearer ${token}` },
      fetch: request,
      exportIntervalMs: 60_000
    })

    await Effect.runPromise(
      Effect.gen(function* () {
        yield* withBobSpan(
          {
            name: "bob.agent.run",
            correlationId,
            feature: "assistant"
          },
          Effect.succeed("done")
        )
        yield* flushTelemetry
      }).pipe(Effect.provide(layer))
    )

    expect(requests).toHaveLength(1)
    expect(requests[0]?.url).toBe("http://collector.example.invalid:4318/v1/traces")
    expect(requests[0]?.headers.get("authorization")).toBe(`Bearer ${token}`)
    expect(requests[0]?.headers.get("content-type")).toBe("application/json")
    expect(requests[0]?.body).not.toContain(token)
    expect(JSON.parse(requests[0]!.body)).toMatchObject({
      resourceSpans: [
        {
          resource: {
            attributes: expect.arrayContaining([
              { key: "service.name", value: { stringValue: "bob-agent" } },
              { key: "service.version", value: { stringValue: releaseSha } },
              { key: "deployment.environment.name", value: { stringValue: "prod" } }
            ])
          },
          scopeSpans: [
            {
              scope: { name: "@bob/observability" },
              spans: [
                expect.objectContaining({
                  name: "bob.agent.run",
                  kind: 2,
                  status: { code: 1 },
                  attributes: expect.arrayContaining([
                    {
                      key: "bob.correlation.id",
                      value: { stringValue: correlationId }
                    }
                  ])
                })
              ]
            }
          ]
        }
      ]
    })
  })

  it("drops new spans when the bounded queue is full", async () => {
    const bodies: string[] = []
    const layer = nodeTelemetryLayer({
      endpoint: "http://collector.example.invalid:4318",
      serviceName: "bob-agent",
      serviceVersion: releaseSha,
      deploymentEnvironment: "prod",
      maxQueueSize: 2,
      maxBatchSize: 2,
      exportIntervalMs: 60_000,
      fetch: vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        bodies.push(String(init?.body))
        return new Response(null, { status: 200 })
      }) as typeof fetch
    })

    await Effect.runPromise(
      Effect.gen(function* () {
        for (const name of ["bob.agent.run", "bob.agent.turn", "bob.model.complete"] as const) {
          yield* withBobSpan({ name, correlationId, feature: "assistant" }, Effect.void)
        }
        yield* flushTelemetry
      }).pipe(Effect.provide(layer))
    )

    const payload = JSON.parse(bodies[0]!) as {
      resourceSpans: Array<{ scopeSpans: Array<{ spans: Array<{ name: string }> }> }>
    }
    expect(bodies).toHaveLength(1)
    expect(payload.resourceSpans[0]?.scopeSpans[0]?.spans.map((span) => span.name)).toEqual([
      "bob.agent.run",
      "bob.agent.turn"
    ])
  })

  it("splits an explicit flush into bounded OTLP batches", async () => {
    const batches: Array<Array<string>> = []
    const layer = nodeTelemetryLayer({
      endpoint: "http://collector.example.invalid:4318",
      serviceName: "bob-agent",
      serviceVersion: releaseSha,
      deploymentEnvironment: "prod",
      maxQueueSize: 3,
      maxBatchSize: 1,
      exportIntervalMs: 60_000,
      fetch: vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        const payload = JSON.parse(String(init?.body)) as {
          resourceSpans: Array<{ scopeSpans: Array<{ spans: Array<{ name: string }> }> }>
        }
        batches.push(payload.resourceSpans[0]?.scopeSpans[0]?.spans.map((span) => span.name) ?? [])
        return new Response(null, { status: 200 })
      }) as typeof fetch
    })

    await Effect.runPromise(
      Effect.gen(function* () {
        for (const name of ["bob.agent.run", "bob.agent.turn", "bob.model.complete"] as const) {
          yield* withBobSpan({ name, correlationId, feature: "assistant" }, Effect.void)
        }
        yield* flushTelemetry
      }).pipe(Effect.provide(layer))
    )

    expect(batches).toEqual([["bob.agent.run"], ["bob.agent.turn"], ["bob.model.complete"]])
  })

  it("exports ended spans while the scoped Layer remains active", async () => {
    const request = vi.fn(async () => new Response(null, { status: 200 })) as typeof fetch
    const layer = nodeTelemetryLayer({
      endpoint: "http://collector.example.invalid:4318",
      serviceName: "bob-agent",
      serviceVersion: releaseSha,
      deploymentEnvironment: "prod",
      exportIntervalMs: 5,
      fetch: request
    })

    await Effect.runPromise(
      Effect.gen(function* () {
        yield* withBobSpan(
          { name: "bob.agent.run", correlationId, feature: "assistant" },
          Effect.void
        )
        yield* Effect.sleep("20 millis")
        expect(request).toHaveBeenCalledTimes(1)
      }).pipe(Effect.provide(layer))
    )
  })

  it("flushes queued spans when the scoped Layer closes", async () => {
    const request = vi.fn(async () => new Response(null, { status: 200 })) as typeof fetch
    const layer = nodeTelemetryLayer({
      endpoint: "http://collector.example.invalid:4318",
      serviceName: "bob-agent",
      serviceVersion: releaseSha,
      deploymentEnvironment: "prod",
      exportIntervalMs: 60_000,
      fetch: request
    })

    await Effect.runPromise(
      withBobSpan({ name: "bob.agent.run", correlationId, feature: "assistant" }, Effect.void).pipe(
        Effect.tap(() => Effect.sync(() => expect(request).not.toHaveBeenCalled())),
        Effect.provide(layer)
      )
    )

    expect(request).toHaveBeenCalledTimes(1)
  })

  it("bounds a stalled export without exposing failure content", async () => {
    const privateCanary = "private-phone-+46700000000"
    let body = ""
    let exportAborted = false
    const layer = nodeTelemetryLayer({
      endpoint: "http://collector.example.invalid:4318",
      serviceName: "bob-agent",
      serviceVersion: releaseSha,
      deploymentEnvironment: "prod",
      exportIntervalMs: 60_000,
      exportTimeoutMs: 5,
      fetch: vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        body = String(init?.body)
        await new Promise<void>((_resolve, reject) => {
          const fallback = setTimeout(() => reject(new Error(privateCanary)), 50)
          init?.signal?.addEventListener(
            "abort",
            () => {
              exportAborted = true
              clearTimeout(fallback)
              reject(init.signal?.reason)
            },
            { once: true }
          )
        })
        return new Response(null, { status: 200 })
      }) as typeof fetch
    })

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* withBobSpan(
          { name: "bob.model.complete", correlationId, feature: "assistant" },
          Effect.fail(new Error(privateCanary))
        ).pipe(Effect.exit)
        yield* flushTelemetry
        return "workflow-available"
      }).pipe(Effect.provide(layer))
    )

    expect(result).toBe("workflow-available")
    expect(exportAborted).toBe(true)
    expect(body).not.toContain(privateCanary)
    expect(JSON.parse(body).resourceSpans[0].scopeSpans[0].spans[0]).toMatchObject({
      name: "bob.model.complete",
      status: { code: 2 }
    })
  })
})
