import type { OutboundJob } from "@bob/contracts/jobs"

import { parseTraceparent } from "@bob/observability/propagation"
import { makeCaptureTelemetry } from "@bob/observability/testing"
import { Effect } from "effect"
import { beforeEach, describe, expect, it, vi } from "vitest"

import type { CoreBindings } from "../src/bindings.ts"
import type { CoreComposition } from "../src/composition.ts"
import type { CoreDurableDependencies } from "../src/entrypoints/durable-objects.ts"

import { handleHttp as realHandleHttp } from "../src/entrypoints/http.ts"
import { createCoreWorker, OwnerRunCoordinator, ReminderClock } from "../src/index.ts"
import {
  makeCoreTelemetryInvocation as makeActualTelemetryInvocation,
  type CoreTelemetryInvocation
} from "../src/telemetry.ts"
import { testFixture } from "./test-fixture.ts"

const harness = vi.hoisted(() => ({
  composeCore: vi.fn(),
  handleHttp: vi.fn(),
  handleInboundQueue: vi.fn(),
  handleScheduled: vi.fn(),
  processConversationTurn: vi.fn(),
  // SAFETY: This controlled test fixture matches the asserted contract used by this test.
  telemetryOverride: undefined as CoreTelemetryInvocation | undefined,
  // SAFETY: This controlled test fixture matches the asserted contract used by this test.
  telemetryInvocations: [] as unknown[]
}))

const makeTelemetryInvocation = vi.fn((bindings: CoreBindings) => {
  if (harness.telemetryOverride !== undefined) {
    harness.telemetryInvocations.push(harness.telemetryOverride)
    return harness.telemetryOverride
  }
  const base = makeActualTelemetryInvocation(bindings)
  const invocation = { ...base, flush: vi.fn(base.flush) }
  harness.telemetryInvocations.push(invocation)
  return invocation
})

const worker = createCoreWorker({
  handleHttp: harness.handleHttp,
  handleInboundQueue: harness.handleInboundQueue,
  handleScheduled: harness.handleScheduled,
  makeCoreTelemetryInvocation: makeTelemetryInvocation
})

const durableDependencies = {
  composeCore: harness.composeCore,
  processConversationTurn: harness.processConversationTurn,
  makeCoreTelemetryInvocation: makeTelemetryInvocation
} satisfies CoreDurableDependencies

const eventId = "018e6f65-4d55-7a1b-8df4-4ee15ea1db90"
const correlationId = "018e6f65-4d55-7a1b-8df4-4ee15ea1db94"
const traceparent = "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-1111111111111111-01"

function currentTelemetry(): CoreTelemetryInvocation & {
  readonly flush: ReturnType<typeof vi.fn>
} {
  const invocation = harness.telemetryInvocations.at(-1)
  if (invocation === undefined) throw new Error("Telemetry invocation was not created")
  // SAFETY: This controlled test fixture matches the asserted contract used by this test.
  return invocation as CoreTelemetryInvocation & { readonly flush: ReturnType<typeof vi.fn> }
}

function makeWaitUntilHarness() {
  const pending: Promise<unknown>[] = []
  const waitUntil = vi.fn((promise: Promise<unknown>) => {
    pending.push(promise)
  })
  return { pending, waitUntil }
}

beforeEach(() => {
  vi.clearAllMocks()
  harness.telemetryOverride = undefined
  harness.telemetryInvocations.length = 0
})

describe("Core telemetry composition", () => {
  it("keeps the fetch response when telemetry scheduling throws", async () => {
    // SAFETY: This focused test double implements every platform member exercised by this test.
    const bindings = testFixture<CoreBindings>({})
    const expected = new Response(null, { status: 204 })
    harness.handleHttp.mockImplementation(
      (
        _request: Request,
        _bindings: CoreBindings,
        _access: Parameters<typeof realHandleHttp>[2],
        telemetry: CoreTelemetryInvocation
      ) => telemetry.runPromise(Effect.succeed(expected))
    )
    // SAFETY: This controlled test fixture matches the asserted contract used by this test.
    const context = testFixture<ExecutionContext>({
      waitUntil: vi.fn(() => {
        throw new Error("wait_until_unavailable")
      }),
      passThroughOnException: vi.fn()
    })

    const response = await worker.fetch(new Request("https://core.test/health"), bindings, context)

    expect(response).toBe(expected)
    await vi.waitFor(() => expect(currentTelemetry().flush).toHaveBeenCalledOnce())
  })

  it("creates and flushes one telemetry invocation for a Queue batch", async () => {
    // SAFETY: This focused test double implements every platform member exercised by this test.
    const bindings = testFixture<CoreBindings>({})
    // SAFETY: This focused test double implements every platform member exercised by this test.
    const batch = testFixture<MessageBatch<unknown>>({ queue: "bob-inbound", messages: [] })
    const waits = makeWaitUntilHarness()
    // SAFETY: This controlled test fixture matches the asserted contract used by this test.
    const context = testFixture<ExecutionContext>({
      waitUntil: waits.waitUntil,
      passThroughOnException: vi.fn()
    })
    harness.handleInboundQueue.mockImplementation(
      (
        _batch: MessageBatch<unknown>,
        _bindings: CoreBindings,
        telemetry: CoreTelemetryInvocation
      ) => telemetry.runPromise(Effect.void)
    )

    await worker.queue(batch, bindings, context)
    await Promise.all(waits.pending)

    const telemetry = currentTelemetry()
    expect(harness.telemetryInvocations).toHaveLength(1)
    expect(harness.handleInboundQueue).toHaveBeenCalledWith(batch, bindings, telemetry)
    expect(waits.waitUntil).toHaveBeenCalledOnce()
    expect(telemetry.flush).toHaveBeenCalledOnce()
  })

  it("keeps the Queue result when telemetry scheduling throws", async () => {
    // SAFETY: This focused test double implements every platform member exercised by this test.
    const bindings = testFixture<CoreBindings>({})
    // SAFETY: This focused test double implements every platform member exercised by this test.
    const batch = testFixture<MessageBatch<unknown>>({ queue: "bob-inbound", messages: [] })
    // SAFETY: This controlled test fixture matches the asserted contract used by this test.
    const context = testFixture<ExecutionContext>({
      waitUntil: vi.fn(() => {
        throw new Error("wait_until_unavailable")
      }),
      passThroughOnException: vi.fn()
    })
    harness.handleInboundQueue.mockImplementation(
      (
        _batch: MessageBatch<unknown>,
        _bindings: CoreBindings,
        telemetry: CoreTelemetryInvocation
      ) => telemetry.runPromise(Effect.void)
    )

    await expect(worker.queue(batch, bindings, context)).resolves.toBeUndefined()

    await vi.waitFor(() => expect(currentTelemetry().flush).toHaveBeenCalledOnce())
  })

  it("keeps the scheduled workflow running when telemetry scheduling throws", async () => {
    // SAFETY: This focused test double implements every platform member exercised by this test.
    const bindings = testFixture<CoreBindings>({})
    // SAFETY: This controlled test fixture matches the asserted contract used by this test.
    const context = testFixture<ExecutionContext>({
      waitUntil: vi.fn(() => {
        throw new Error("wait_until_unavailable")
      }),
      passThroughOnException: vi.fn()
    })
    harness.handleScheduled.mockResolvedValue(undefined)

    // SAFETY: This controlled test fixture matches the asserted contract used by this test.
    expect(() => worker.scheduled({} as ScheduledController, bindings, context)).not.toThrow()

    await vi.waitFor(() => expect(harness.handleScheduled).toHaveBeenCalledOnce())
    expect(harness.handleScheduled.mock.calls[0]?.[2]).toBe(currentTelemetry())
    await vi.waitFor(() => expect(currentTelemetry().flush).toHaveBeenCalledOnce())
  })

  it("continues the coordinator client span through one server span", async () => {
    // SAFETY: This focused test double implements every platform member exercised by this test.
    const bindings = testFixture<CoreBindings>({})
    const turnId = "018e6f65-4d55-7a1b-8df4-4ee15ea1db95"
    const quietUntil = "2026-08-12T10:00:01.500Z"
    const turns = {
      offer: vi.fn(async (_eventId: string, _traceparent?: string) => ({
        turnId,
        revision: 1,
        status: "collecting" as const,
        quietUntil,
        appended: true
      }))
    }
    // SAFETY: This focused test double implements every platform member exercised by this test.
    const composition = testFixture<CoreComposition>({ services: { turns } })
    const waits = makeWaitUntilHarness()
    const capture = makeCaptureTelemetry({
      serviceName: "bob-core-worker",
      serviceVersion: "0123456789abcdef0123456789abcdef01234567",
      deploymentEnvironment: "test"
    })
    const flush = vi.fn(async () => undefined)
    harness.telemetryOverride = {
      layer: capture.layer,
      runPromise: (effect) => Effect.runPromise(effect.pipe(Effect.provide(capture.layer))),
      flush
    }
    // SAFETY: This controlled test fixture matches the asserted contract used by this test.
    const state = testFixture<DurableObjectState>({
      storage: {
        getAlarm: vi.fn(async () => null),
        setAlarm: vi.fn(async () => undefined)
      },
      blockConcurrencyWhile: vi.fn((callback: () => Promise<void>) => callback()),
      waitUntil: waits.waitUntil
    })
    harness.composeCore.mockReturnValue(composition)
    const coordinator = new OwnerRunCoordinator(state, bindings, durableDependencies)
    const callerTraceId = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
    const callerSpanId = "2222222222222222"
    const callerTraceparent = `00-${callerTraceId}-${callerSpanId}-01`

    const response = await coordinator.fetch(
      new Request("https://coordinator.internal/run", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          traceparent: callerTraceparent,
          "x-bob-correlation-id": correlationId
        },
        body: JSON.stringify({ eventId, correlationId, traceparent })
      })
    )
    await Promise.all(waits.pending)

    const telemetry = currentTelemetry()
    expect(response.status).toBe(202)
    expect(harness.telemetryInvocations).toHaveLength(1)
    const run = capture.finishedSpans().find((span) => span.name === "bob.coordinator.run")
    const collect = capture.finishedSpans().find((span) => span.name === "bob.turn.collect")
    expect(run).toMatchObject({
      traceId: callerTraceId,
      parentSpanId: callerSpanId,
      kind: "server",
      attributes: expect.objectContaining({ "bob.correlation.id": correlationId })
    })
    expect(collect).toMatchObject({
      traceId: callerTraceId,
      parentSpanId: run?.spanId,
      attributes: expect.objectContaining({ "bob.correlation.id": correlationId }),
      events: [
        expect.objectContaining({
          name: "bob.state.transition",
          attributes: {
            "bob.decision.code": "new",
            "bob.decision.outcome": "applied",
            "bob.conversation.revision": 1
          }
        })
      ]
    })
    const forwardedTraceparent = turns.offer.mock.calls[0]?.[1]
    expect(parseTraceparent(forwardedTraceparent)).toEqual({
      traceId: collect?.traceId,
      spanId: collect?.spanId,
      sampled: true
    })
    expect(turns.offer).toHaveBeenCalledWith(eventId, forwardedTraceparent)
    expect(state.blockConcurrencyWhile).toHaveBeenCalledOnce()
    expect(waits.waitUntil).toHaveBeenCalledOnce()
    expect(telemetry.flush).toHaveBeenCalledOnce()
  })

  it("continues the Core cancel span into the Agent abort request", async () => {
    // SAFETY: This focused test double implements every platform member exercised by this test.
    const bindings = testFixture<CoreBindings>({})
    const turnId = "018e6f65-4d55-7a1b-8df4-4ee15ea1db95"
    const runId = "018e6f65-4d55-7a1b-8df4-4ee15ea1db96"
    const quietUntil = "2026-08-12T10:00:01.500Z"
    const turns = {
      offer: vi.fn(async () => ({
        turnId,
        revision: 2,
        status: "collecting" as const,
        quietUntil,
        appended: true,
        activeRunId: runId
      })),
      markSettling: vi.fn(async () => ({
        claimExpiresAt: "2026-08-12T10:01:30.000Z"
      }))
    }
    // SAFETY: This controlled test fixture matches the asserted contract used by this test.
    harness.composeCore.mockReturnValue(
      testFixture<CoreComposition>({
        config: {
          AGENT_URL: "https://agent.example.invalid",
          AGENT_ACCESS_CLIENT_ID: "client",
          AGENT_ACCESS_CLIENT_SECRET: "secret"
        },
        services: { turns }
      })
    )
    const capture = makeCaptureTelemetry({
      serviceName: "bob-core-worker",
      serviceVersion: "0123456789abcdef0123456789abcdef01234567",
      deploymentEnvironment: "test"
    })
    harness.telemetryOverride = {
      layer: capture.layer,
      runPromise: (effect) => Effect.runPromise(effect.pipe(Effect.provide(capture.layer))),
      flush: vi.fn(async () => undefined)
    }
    let steerHeaders: Headers | undefined
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        steerHeaders = new Headers(init?.headers)
        return Response.json({ status: "aborted_model" })
      })
    )
    const waits = makeWaitUntilHarness()
    // SAFETY: This controlled test fixture matches the asserted contract used by this test.
    const state = testFixture<DurableObjectState>({
      storage: {
        getAlarm: vi.fn(async () => null),
        setAlarm: vi.fn(async () => undefined)
      },
      blockConcurrencyWhile: vi.fn((callback: () => Promise<void>) => callback()),
      waitUntil: waits.waitUntil
    })
    const coordinator = new OwnerRunCoordinator(state, bindings, durableDependencies)

    const response = await coordinator.fetch(
      new Request("https://coordinator.internal/run", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-bob-correlation-id": correlationId
        },
        body: JSON.stringify({ eventId, correlationId })
      })
    )
    await Promise.all(waits.pending)

    expect(response.status).toBe(202)
    const spans = capture.finishedSpans()
    const collect = spans.find((span) => span.name === "bob.turn.collect")
    const cancel = spans.find((span) => span.name === "bob.run.cancel_request")
    expect(collect?.events).toContainEqual(
      expect.objectContaining({
        name: "bob.state.transition",
        attributes: {
          "bob.decision.code": "burst_append",
          "bob.decision.outcome": "applied",
          "bob.conversation.revision": 2
        }
      })
    )
    expect(collect?.attributes).toMatchObject({
      "bob.conversation.turn_id": turnId,
      "bob.conversation.revision": 2
    })
    expect(cancel).toMatchObject({
      traceId: collect?.traceId,
      parentSpanId: collect?.spanId
    })
    expect(cancel?.attributes).toMatchObject({
      "bob.correlation.id": correlationId,
      "bob.run.id": runId,
      "bob.conversation.turn_id": turnId,
      "bob.conversation.revision": 2
    })
    expect(parseTraceparent(steerHeaders?.get("traceparent"))).toEqual({
      traceId: cancel?.traceId,
      spanId: cancel?.spanId,
      sampled: true
    })
    expect(steerHeaders?.get("x-bob-correlation-id")).toBe(correlationId)
  })

  it("accepts the clock request and starts one isolated root per durable outbox", async () => {
    const firstOutboxId = "018e6f65-4d55-7a1b-8df4-4ee15ea1db95"
    const secondOutboxId = "018e6f65-4d55-7a1b-8df4-4ee15ea1db96"
    const firstCorrelationId = "018e6f65-4d55-7a1b-8df4-4ee15ea1db97"
    const secondCorrelationId = "018e6f65-4d55-7a1b-8df4-4ee15ea1db98"
    const occurrenceId = "018e6f65-4d55-7a1b-8df4-4ee15ea1db99"
    const capture = makeCaptureTelemetry({
      serviceName: "bob-core-worker",
      serviceVersion: "0123456789abcdef0123456789abcdef01234567",
      deploymentEnvironment: "test"
    })
    harness.telemetryOverride = {
      layer: capture.layer,
      runPromise: (effect) => Effect.runPromise(effect.pipe(Effect.provide(capture.layer))),
      flush: vi.fn(async () => undefined)
    }
    const select = vi
      .fn()
      .mockReturnValueOnce({
        from: () => ({
          where: () => ({
            limit: async () => [
              {
                correlationId: firstCorrelationId,
                actionTargetType: "reminder_occurrence",
                actionTargetId: occurrenceId
              }
            ]
          })
        })
      })
      .mockReturnValueOnce({
        from: () => ({
          where: () => ({
            limit: async () => [
              {
                correlationId: secondCorrelationId,
                actionTargetType: "reminder_occurrence",
                actionTargetId: "legacy-unsafe-occurrence"
              }
            ]
          })
        })
      })
    const markEnqueued = vi.fn(async () => undefined)
    // SAFETY: This controlled test fixture matches the asserted contract used by this test.
    harness.composeCore.mockReturnValue(
      testFixture<CoreComposition>({
        config: { OWNER_ID: correlationId },
        database: { select },
        services: {
          reminders: {
            claimDueAndCreateOutbox: vi.fn(async () => [firstOutboxId, secondOutboxId]),
            nextDue: vi.fn(async () => undefined)
          },
          delivery: { markEnqueued }
        }
      })
    )
    const published: unknown[] = []
    // SAFETY: This controlled test fixture matches the asserted contract used by this test.
    const bindings = testFixture<CoreBindings>({
      OUTBOUND_QUEUE: { send: async (job: OutboundJob) => published.push(job) }
    })
    const waits = makeWaitUntilHarness()
    // SAFETY: This controlled test fixture matches the asserted contract used by this test.
    const state = testFixture<DurableObjectState>({
      storage: { deleteAlarm: vi.fn(async () => undefined) },
      waitUntil: waits.waitUntil
    })
    const clock = new ReminderClock(state, bindings, durableDependencies)
    const callerTraceId = "cccccccccccccccccccccccccccccccc"
    const callerSpanId = "3333333333333333"

    const response = await clock.fetch(
      new Request("https://clock.internal/reconcile", {
        method: "POST",
        headers: {
          traceparent: `00-${callerTraceId}-${callerSpanId}-01`,
          "x-bob-correlation-id": correlationId
        }
      })
    )
    await Promise.all(waits.pending)

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true, dueCount: 2 })
    const spans = capture.finishedSpans()
    const accept = spans.find((span) => span.name === "bob.reminder.accept")
    const dispatches = spans.filter((span) => span.name === "bob.reminder.dispatch")
    expect(accept).toMatchObject({
      traceId: callerTraceId,
      parentSpanId: callerSpanId,
      kind: "server",
      attributes: expect.objectContaining({ "bob.correlation.id": correlationId })
    })
    expect(dispatches).toHaveLength(2)
    expect(dispatches.map((span) => span.parentSpanId)).toEqual([undefined, undefined])
    expect(new Set(dispatches.map((span) => span.traceId)).size).toBe(2)
    expect(dispatches.map((span) => span.traceId)).not.toContain(callerTraceId)
    expect(dispatches[0]?.attributes).toMatchObject({
      "bob.correlation.id": firstCorrelationId,
      "bob.outbox.id": firstOutboxId,
      "bob.reminder.occurrence_id": occurrenceId
    })
    expect(dispatches[1]?.attributes).toMatchObject({
      "bob.correlation.id": secondCorrelationId,
      "bob.outbox.id": secondOutboxId
    })
    expect(dispatches[1]?.attributes).not.toHaveProperty("bob.reminder.occurrence_id")
    for (const [index, dispatch] of dispatches.entries()) {
      // SAFETY: This controlled test fixture matches the asserted contract used by this test.
      const job = published[index] as { readonly traceparent?: string }
      expect(parseTraceparent(job.traceparent)).toEqual({
        traceId: dispatch.traceId,
        spanId: dispatch.spanId,
        sampled: true
      })
    }
    expect(markEnqueued).toHaveBeenCalledTimes(2)
  })

  it("keeps the owner run result when telemetry scheduling throws", async () => {
    // SAFETY: This focused test double implements every platform member exercised by this test.
    const bindings = testFixture<CoreBindings>({})
    const turnId = "018e6f65-4d55-7a1b-8df4-4ee15ea1db95"
    const turns = {
      offer: vi.fn(async (_eventId: string, _traceparent?: string) => ({
        turnId,
        revision: 1,
        status: "collecting" as const,
        quietUntil: "2026-08-12T10:00:01.500Z",
        appended: true
      }))
    }
    // SAFETY: This focused test double implements every platform member exercised by this test.
    const composition = testFixture<CoreComposition>({ services: { turns } })
    // SAFETY: This controlled test fixture matches the asserted contract used by this test.
    const state = testFixture<DurableObjectState>({
      storage: {
        getAlarm: vi.fn(async () => null),
        setAlarm: vi.fn(async () => undefined)
      },
      blockConcurrencyWhile: vi.fn((callback: () => Promise<void>) => callback()),
      waitUntil: vi.fn(() => {
        throw new Error("wait_until_unavailable")
      })
    })
    harness.composeCore.mockReturnValue(composition)
    const coordinator = new OwnerRunCoordinator(state, bindings, durableDependencies)

    const response = await coordinator.fetch(
      new Request("https://coordinator.internal/run", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ eventId, correlationId, traceparent })
      })
    )

    expect(response.status).toBe(202)
    expect(await response.json()).toEqual({ ok: true, turnId, revision: 1 })
    await vi.waitFor(() => expect(currentTelemetry().flush).toHaveBeenCalledOnce())
  })

  it("keeps the reminder clock result when telemetry scheduling throws", async () => {
    // SAFETY: This focused test double implements every platform member exercised by this test.
    const bindings = testFixture<CoreBindings>({})
    const deleteAlarm = vi.fn(async () => undefined)
    // SAFETY: This controlled test fixture matches the asserted contract used by this test.
    const state = testFixture<DurableObjectState>({
      storage: { deleteAlarm },
      waitUntil: vi.fn(() => {
        throw new Error("wait_until_unavailable")
      })
    })
    // SAFETY: This controlled test fixture matches the asserted contract used by this test.
    harness.composeCore.mockReturnValue(
      testFixture<CoreComposition>({
        config: { OWNER_ID: correlationId },
        services: {
          reminders: {
            claimDueAndCreateOutbox: vi.fn(async () => []),
            nextDue: vi.fn(async () => undefined)
          }
        }
      })
    )
    const clock = new ReminderClock(state, bindings, durableDependencies)

    const response = await clock.fetch(
      new Request("https://clock.internal/reconcile", {
        method: "POST",
        headers: { "x-bob-correlation-id": correlationId }
      })
    )

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true, dueCount: 0 })
    expect(deleteAlarm).toHaveBeenCalledOnce()
    await vi.waitFor(() => expect(currentTelemetry().flush).toHaveBeenCalledOnce())
  })
})
