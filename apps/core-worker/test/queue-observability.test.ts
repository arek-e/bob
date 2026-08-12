import { parseTraceparent } from "@bob/observability/propagation"
import { makeCaptureTelemetry } from "@bob/observability/testing"
import { Effect } from "effect"
import { beforeEach, describe, expect, it, vi } from "vitest"

import type { CoreBindings } from "../src/bindings.ts"
import type { CoreComposition } from "../src/composition.ts"

import { handleInboundQueue } from "../src/entrypoints/queue.ts"

const compositionHarness = vi.hoisted(() => ({
  current: undefined as CoreComposition | undefined
}))

vi.mock("../src/composition.ts", () => ({
  composeCore: () => compositionHarness.current
}))

const eventId = "018e6f65-4d55-7a1b-8df4-4ee15ea1db90"
const ownerId = "018e6f65-4d55-7a1b-8df4-4ee15ea1db91"
const correlationId = "018e6f65-4d55-7a1b-8df4-4ee15ea1db94"
const outboxId = "018e6f65-4d55-7a1b-8df4-4ee15ea1db95"
const attemptId = "018e6f65-4d55-7a1b-8df4-4ee15ea1db96"
const inboundTraceId = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
const inboundParentSpanId = "1111111111111111"
const inboundTraceparent = `00-${inboundTraceId}-${inboundParentSpanId}-01`

function captureRunner(telemetry: ReturnType<typeof makeCaptureTelemetry>) {
  return {
    runPromise: <A, E>(effect: Effect.Effect<A, E>) =>
      Effect.runPromise(effect.pipe(Effect.provide(telemetry.layer)))
  }
}

function queueMessage(body: unknown) {
  return {
    body,
    ack: vi.fn(),
    retry: vi.fn()
  }
}

beforeEach(() => {
  compositionHarness.current = undefined
})

describe("Core Queue telemetry", () => {
  it("continues the inbound trace through the Queue consumer", async () => {
    const telemetry = makeCaptureTelemetry({
      serviceName: "bob-core",
      serviceVersion: "0123456789abcdef0123456789abcdef01234567",
      deploymentEnvironment: "test"
    })
    const forwarded: Array<{ readonly body: unknown; readonly headers: Headers }> = []
    const message = queueMessage({ eventId, correlationId, traceparent: inboundTraceparent })
    compositionHarness.current = {
      services: {
        conversations: {
          getInboundOwner: vi.fn(async () => ownerId)
        }
      }
    } as unknown as CoreComposition
    const coordinator = {
      fetch: vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        forwarded.push({
          body: JSON.parse(String(init?.body)) as unknown,
          headers: new Headers(init?.headers)
        })
        return Response.json({ ok: true })
      })
    }
    const namespace = {
      idFromName: vi.fn(() => ({ toString: () => ownerId })),
      get: vi.fn(() => coordinator)
    }
    const bindings = {
      DELIVERY_RESULT_QUEUE_NAME: "delivery-result",
      DELIVERY_RESULT_DEAD_LETTER_QUEUE_NAME: "delivery-result-dead-letter",
      INBOUND_DEAD_LETTER_QUEUE_NAME: "inbound-dead-letter",
      OWNER_RUN_COORDINATOR: {
        jurisdiction: vi.fn(() => namespace)
      }
    } as unknown as CoreBindings
    const batch = {
      queue: "inbound",
      messages: [message]
    } as unknown as MessageBatch<unknown>

    await handleInboundQueue(batch, bindings, captureRunner(telemetry))

    expect(message.ack).toHaveBeenCalledOnce()
    expect(message.retry).not.toHaveBeenCalled()
    const consume = telemetry.finishedSpans().find((span) => span.name === "bob.inbound.consume")
    const invoke = telemetry.finishedSpans().find((span) => span.name === "bob.coordinator.invoke")
    expect(consume?.traceId).toBe(inboundTraceId)
    expect(consume?.parentSpanId).toBe(inboundParentSpanId)
    expect(invoke?.traceId).toBe(inboundTraceId)
    expect(invoke?.parentSpanId).toBe(consume?.spanId)
    expect(invoke?.kind).toBe("client")
    expect(forwarded).toEqual([
      {
        body: {
          eventId,
          correlationId,
          traceparent: expect.stringMatching(new RegExp(`^00-${inboundTraceId}-[0-9a-f]{16}-01$`))
        },
        headers: expect.any(Headers)
      }
    ])
    expect(forwarded[0]?.headers.get("x-bob-correlation-id")).toBe(correlationId)
    const headerTrace = parseTraceparent(forwarded[0]?.headers.get("traceparent"))
    const bodyTrace = parseTraceparent(
      (forwarded[0]?.body as { readonly traceparent?: string } | undefined)?.traceparent
    )
    expect(headerTrace?.spanId).toBe(invoke?.spanId)
    expect(bodyTrace).toEqual(headerTrace)
  })

  it("publishes an inbound DLQ recovery from one producer span", async () => {
    const telemetry = makeCaptureTelemetry({
      serviceName: "bob-core",
      serviceVersion: "0123456789abcdef0123456789abcdef01234567",
      deploymentEnvironment: "test"
    })
    const message = queueMessage({ eventId, correlationId, traceparent: inboundTraceparent })
    const send = vi.fn(async (_job: unknown) => undefined)
    const markEnqueued = vi.fn(async () => undefined)
    compositionHarness.current = {
      services: {
        conversations: {
          getInboundOwner: vi.fn(async () => ownerId),
          prepareInboundRecovery: vi.fn(async () => "recover"),
          markEnqueued
        },
        alerts: { record: vi.fn(async () => undefined) }
      }
    } as unknown as CoreComposition
    const bindings = {
      DELIVERY_RESULT_QUEUE_NAME: "delivery-result",
      DELIVERY_RESULT_DEAD_LETTER_QUEUE_NAME: "delivery-result-dead-letter",
      INBOUND_DEAD_LETTER_QUEUE_NAME: "inbound-dead-letter",
      INBOUND_QUEUE: { send }
    } as unknown as CoreBindings
    const batch = {
      queue: "inbound-dead-letter",
      messages: [message]
    } as unknown as MessageBatch<unknown>

    await handleInboundQueue(batch, bindings, captureRunner(telemetry))

    expect(message.ack).toHaveBeenCalledOnce()
    expect(message.retry).not.toHaveBeenCalled()
    expect(markEnqueued).toHaveBeenCalledOnce()
    const consume = telemetry.finishedSpans().find((span) => span.name === "bob.inbound.consume")
    const publish = telemetry.finishedSpans().find((span) => span.name === "bob.inbound.publish")
    expect(publish).toMatchObject({
      traceId: inboundTraceId,
      parentSpanId: consume?.spanId,
      kind: "producer",
      attributes: expect.objectContaining({ "bob.correlation.id": correlationId })
    })
    const published = send.mock.calls[0]?.[0] as { readonly traceparent?: string }
    expect(parseTraceparent(published.traceparent)).toEqual({
      traceId: publish?.traceId,
      spanId: publish?.spanId,
      sampled: true
    })
  })

  it("traces delivery result consumption and recording without provider data", async () => {
    const telemetry = makeCaptureTelemetry({
      serviceName: "bob-core",
      serviceVersion: "0123456789abcdef0123456789abcdef01234567",
      deploymentEnvironment: "test"
    })
    const privateProviderHandle = "private-provider-handle-7721"
    const recordResult = vi.fn(async () => undefined)
    const message = queueMessage({
      outboxId,
      attemptId,
      correlationId,
      traceparent: inboundTraceparent,
      state: "accepted",
      providerMessageHandle: privateProviderHandle,
      occurredAt: "2026-08-11T10:00:01.000Z"
    })
    compositionHarness.current = {
      services: {
        delivery: { recordResult }
      }
    } as unknown as CoreComposition
    const bindings = {
      DELIVERY_RESULT_QUEUE_NAME: "delivery-result",
      DELIVERY_RESULT_DEAD_LETTER_QUEUE_NAME: "delivery-result-dead-letter"
    } as unknown as CoreBindings
    const batch = {
      queue: "delivery-result",
      messages: [message]
    } as unknown as MessageBatch<unknown>

    await handleInboundQueue(batch, bindings, captureRunner(telemetry))

    expect(recordResult).toHaveBeenCalledOnce()
    expect(message.ack).toHaveBeenCalledOnce()
    expect(message.retry).not.toHaveBeenCalled()
    const spans = telemetry.finishedSpans()
    const consume = spans.find((span) => span.name === "bob.delivery_result.consume")
    const record = spans.find((span) => span.name === "bob.delivery_result.record")
    expect(consume?.traceId).toBe(inboundTraceId)
    expect(consume?.parentSpanId).toBe(inboundParentSpanId)
    expect(record?.parentSpanId).toBe(consume?.spanId)
    expect(record?.attributes).toMatchObject({
      "bob.correlation.id": correlationId,
      "bob.outbox.id": outboxId,
      "bob.delivery.attempt_id": attemptId
    })
    expect(
      JSON.stringify(spans, (_key, value) => (typeof value === "bigint" ? value.toString() : value))
    ).not.toContain(privateProviderHandle)
  })

  it("keeps the durable retry when delivery result recording fails", async () => {
    const telemetry = makeCaptureTelemetry({
      serviceName: "bob-core",
      serviceVersion: "0123456789abcdef0123456789abcdef01234567",
      deploymentEnvironment: "test"
    })
    const privateError = "private-delivery-store-error-9912"
    const message = queueMessage({
      outboxId,
      attemptId,
      correlationId,
      traceparent: inboundTraceparent,
      state: "accepted",
      occurredAt: "2026-08-11T10:00:01.000Z"
    })
    compositionHarness.current = {
      services: {
        delivery: {
          recordResult: vi.fn(async () => {
            throw new Error(privateError)
          })
        }
      }
    } as unknown as CoreComposition
    const bindings = {
      DELIVERY_RESULT_QUEUE_NAME: "delivery-result",
      DELIVERY_RESULT_DEAD_LETTER_QUEUE_NAME: "delivery-result-dead-letter"
    } as unknown as CoreBindings
    const batch = {
      queue: "delivery-result",
      messages: [message]
    } as unknown as MessageBatch<unknown>

    await handleInboundQueue(batch, bindings, captureRunner(telemetry))

    expect(message.ack).not.toHaveBeenCalled()
    expect(message.retry).toHaveBeenCalledWith({ delaySeconds: 60 })
    const spans = telemetry.finishedSpans()
    expect(spans.find((span) => span.name === "bob.delivery_result.consume")?.outcome).toBe(
      "failed"
    )
    expect(spans.find((span) => span.name === "bob.delivery_result.record")?.outcome).toBe("failed")
    expect(
      JSON.stringify(spans, (_key, value) => (typeof value === "bigint" ? value.toString() : value))
    ).not.toContain(privateError)
  })
})
