import type { OutboundJob } from "@bob/contracts/jobs"

import { parseTraceparent } from "@bob/observability/propagation"
import { makeCaptureTelemetry } from "@bob/observability/testing"
import { Effect } from "effect"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { TransitionalBindings } from "../src/bindings.ts"
import type { CoreComposition } from "../src/composition.ts"
import type { ReminderStore } from "../src/modules/reminders/store.ts"

import { handleScheduled } from "../src/entrypoints/scheduled.ts"
import { makeReminderScheduledWorkflow } from "../src/modules/reminders/scheduled-workflow.ts"
import { makeRuntimeModules } from "../src/modules/runtime/module.ts"
import { testFixture } from "./test-fixture.ts"

const compositionHarness = vi.hoisted(() => ({
  // SAFETY: This focused test double implements every platform member exercised by this test.
  current: undefined as CoreComposition | undefined
}))

function composeTestCore(): CoreComposition {
  if (compositionHarness.current === undefined) throw new Error("Test composition is not set")
  return compositionHarness.current
}

const scheduledCorrelationId = "018e6f65-4d55-7a1b-8df4-4ee15ea1db90"
const firstCorrelationId = "018e6f65-4d55-7a1b-8df4-4ee15ea1db91"
const secondCorrelationId = "018e6f65-4d55-7a1b-8df4-4ee15ea1db92"
const firstOutboxId = "018e6f65-4d55-7a1b-8df4-4ee15ea1db93"
const secondOutboxId = "018e6f65-4d55-7a1b-8df4-4ee15ea1db94"
const occurrenceId = "018e6f65-4d55-7a1b-8df4-4ee15ea1db95"
const traceId = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
const parentSpanId = "1111111111111111"
const traceparent = `00-${traceId}-${parentSpanId}-01`

function captureRunner(telemetry: ReturnType<typeof makeCaptureTelemetry>) {
  return {
    runPromise: <A, E>(effect: Effect.Effect<A, E>) =>
      Effect.runPromise(effect.pipe(Effect.provide(telemetry.layer)))
  }
}

beforeEach(() => {
  compositionHarness.current = undefined
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("Core scheduled telemetry", () => {
  it("uses client spans for the clock and one producer span per pending outbox", async () => {
    const telemetry = makeCaptureTelemetry({
      serviceName: "bob-core",
      serviceVersion: "0123456789abcdef0123456789abcdef01234567",
      deploymentEnvironment: "test"
    })
    const schedulerItem = {
      id: "018e6f65-4d55-7a1b-8df4-4ee15ea1db96",
      reminderId: "018e6f65-4d55-7a1b-8df4-4ee15ea1db97",
      scheduleRevision: 1,
      command: "upsert"
    }
    const pendingOutbox = [
      {
        id: firstOutboxId,
        correlationId: firstCorrelationId,
        actionTargetType: "reminder_occurrence",
        actionTargetId: occurrenceId
      },
      {
        id: secondOutboxId,
        correlationId: secondCorrelationId,
        actionTargetType: "reminder_occurrence",
        actionTargetId: "legacy-unsafe-occurrence"
      }
    ]
    const select = vi
      .fn()
      .mockReturnValueOnce({
        from: () => ({
          where: () => ({ orderBy: () => ({ limit: async () => [schedulerItem] }) })
        })
      })
      .mockReturnValueOnce({
        from: () => ({ where: () => ({ limit: async () => pendingOutbox }) })
      })
    const update = vi.fn(() => ({
      set: () => ({ where: async () => undefined })
    }))
    const markEnqueued = vi.fn(async () => undefined)
    // SAFETY: This controlled test fixture matches the asserted contract used by this test.
    const reminders = testFixture<ReminderStore>({
      releaseExpiredClaims: vi.fn(async () => 0),
      markExpiredResponseDeadlines: vi.fn(async () => 0)
    })
    compositionHarness.current = testFixture<CoreComposition>({
      config: { OWNER_ID: scheduledCorrelationId },
      database: { select, update },
      services: {
        delivery: {
          reconcileExpiredClaims: vi.fn(async () => 0),
          markEnqueued
        },
        reminders
      }
    })
    const clockRequests: RequestInit[] = []
    const clock = {
      fetch: vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        if (init !== undefined) clockRequests.push(init)
        return Response.json({ ok: true })
      })
    }
    const namespace = {
      idFromName: vi.fn(() => ({ toString: () => scheduledCorrelationId })),
      get: vi.fn(() => clock)
    }
    const published: unknown[] = []
    const recoveryFetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      Response.json({ retrieved: 0, replayed: 0, skipped: 0 })
    )
    vi.stubGlobal("fetch", recoveryFetch)
    // SAFETY: This controlled test fixture matches the asserted contract used by this test.
    const bindings = testFixture<TransitionalBindings>({
      REMINDER_CLOCK: { jurisdiction: vi.fn(() => namespace) },
      OUTBOUND_QUEUE: { send: async (job: OutboundJob) => published.push(job) },
      SENDBLUE_EGRESS_URL: "https://egress.example.invalid",
      EGRESS_CALLER_SECRET: "c".repeat(64)
    })
    compositionHarness.current = {
      ...compositionHarness.current,
      runtime: makeRuntimeModules({
        scheduledTasks: [
          makeReminderScheduledWorkflow({
            bindings,
            database: compositionHarness.current.database,
            reminders,
            ownerId: scheduledCorrelationId
          })
        ]
      })
    }

    await handleScheduled(
      bindings,
      {
        correlationId: scheduledCorrelationId,
        traceparent,
        scheduledAt: new Date("2026-08-13T10:32:00.000Z")
      },
      captureRunner(telemetry),
      composeTestCore
    )

    const spans = telemetry.finishedSpans()
    const clockInvokes = spans.filter((span) => span.name === "bob.reminder.invoke")
    const outboxPublishes = spans.filter((span) => span.name === "bob.outbox.publish")
    expect(clockInvokes).toHaveLength(2)
    expect(outboxPublishes).toHaveLength(2)
    expect(clockInvokes.map((span) => span.parentSpanId)).toEqual([parentSpanId, parentSpanId])
    expect(outboxPublishes.map((span) => span.parentSpanId)).toEqual([undefined, undefined])
    expect(outboxPublishes.map((span) => span.traceId)).not.toContain(traceId)
    expect(new Set(outboxPublishes.map((span) => span.traceId)).size).toBe(2)
    for (const [index, invoke] of clockInvokes.entries()) {
      expect(
        parseTraceparent(new Headers(clockRequests[index]?.headers).get("traceparent"))
      ).toEqual({
        traceId: invoke.traceId,
        spanId: invoke.spanId,
        sampled: true
      })
    }
    for (const [index, publish] of outboxPublishes.entries()) {
      // SAFETY: This controlled test fixture matches the asserted contract used by this test.
      const job = published[index] as { readonly traceparent?: string }
      expect(parseTraceparent(job.traceparent)).toEqual({
        traceId: publish.traceId,
        spanId: publish.spanId,
        sampled: true
      })
    }
    expect(outboxPublishes[0]?.attributes).toMatchObject({
      "bob.correlation.id": firstCorrelationId,
      "bob.outbox.id": firstOutboxId,
      "bob.feature": "delivery"
    })
    expect(outboxPublishes[1]?.attributes).toMatchObject({
      "bob.correlation.id": secondCorrelationId,
      "bob.outbox.id": secondOutboxId
    })
    expect(outboxPublishes[1]?.attributes).not.toHaveProperty("bob.reminder.occurrence_id")
    expect(markEnqueued).toHaveBeenCalledTimes(2)
    expect(recoveryFetch).toHaveBeenCalledOnce()
    expect(String(recoveryFetch.mock.calls[0]?.[0])).toBe(
      "https://egress.example.invalid/internal/inbound-reconcile"
    )
    expect(recoveryFetch.mock.calls[0]?.[1]).toMatchObject({ method: "POST" })
    expect(new Headers(recoveryFetch.mock.calls[0]?.[1]?.headers).get("x-bob-caller-token")).toBe(
      "c".repeat(64)
    )
  })

  it("continues later reminders and delivery recovery after one clock item fails", async () => {
    const schedulerItems = [
      {
        id: "018e6f65-4d55-7a1b-8df4-4ee15ea1dba0",
        reminderId: "018e6f65-4d55-7a1b-8df4-4ee15ea1dba1",
        userId: scheduledCorrelationId,
        scheduleRevision: 1,
        command: "upsert",
        processedAt: null,
        createdAt: "2026-08-13T10:00:00.000Z"
      },
      {
        id: "018e6f65-4d55-7a1b-8df4-4ee15ea1dba2",
        reminderId: "018e6f65-4d55-7a1b-8df4-4ee15ea1dba3",
        userId: scheduledCorrelationId,
        scheduleRevision: 1,
        command: "upsert",
        processedAt: null,
        createdAt: "2026-08-13T10:00:01.000Z"
      }
    ] as const
    const pendingOutbox = [
      {
        id: firstOutboxId,
        correlationId: firstCorrelationId,
        actionTargetType: null,
        actionTargetId: null
      }
    ]
    const select = vi
      .fn()
      .mockReturnValueOnce({
        from: () => ({
          where: () => ({ orderBy: () => ({ limit: async () => schedulerItems }) })
        })
      })
      .mockReturnValueOnce({
        from: () => ({ where: () => ({ limit: async () => pendingOutbox }) })
      })
    const markEnqueued = vi.fn(async () => undefined)
    // SAFETY: This controlled test fixture matches the asserted contract used by this test.
    const reminders = testFixture<ReminderStore>({
      releaseExpiredClaims: vi.fn(async () => 0),
      markExpiredResponseDeadlines: vi.fn(async () => 0)
    })
    compositionHarness.current = testFixture<CoreComposition>({
      config: { OWNER_ID: scheduledCorrelationId },
      database: {
        select,
        update: vi.fn(() => ({ set: () => ({ where: async () => undefined }) }))
      },
      services: {
        delivery: { reconcileExpiredClaims: vi.fn(async () => 0), markEnqueued },
        reminders
      }
    })
    let commandCount = 0
    const clock = {
      fetch: vi.fn(async (input: RequestInfo | URL) => {
        if (String(input).endsWith("/command")) {
          commandCount += 1
          return new Response(null, { status: commandCount === 1 ? 503 : 200 })
        }
        return new Response(null, { status: 200 })
      })
    }
    const namespace = {
      idFromName: vi.fn(() => ({ toString: () => scheduledCorrelationId })),
      get: vi.fn(() => clock)
    }
    const send = vi.fn(async () => undefined)
    // SAFETY: This controlled test fixture matches the asserted contract used by this test.
    const bindings = testFixture<TransitionalBindings>({
      REMINDER_CLOCK: { jurisdiction: vi.fn(() => namespace) },
      OUTBOUND_QUEUE: { send }
    })
    compositionHarness.current = {
      ...compositionHarness.current,
      runtime: makeRuntimeModules({
        scheduledTasks: [
          makeReminderScheduledWorkflow({
            bindings,
            database: compositionHarness.current.database,
            reminders,
            ownerId: scheduledCorrelationId
          })
        ]
      })
    }

    await expect(
      handleScheduled(
        bindings,
        {
          correlationId: scheduledCorrelationId,
          scheduledAt: new Date("2026-08-13T10:31:00.000Z")
        },
        undefined,
        composeTestCore
      )
    ).rejects.toThrow("scheduled_recovery_failed")

    expect(commandCount).toBe(2)
    expect(clock.fetch).toHaveBeenCalledWith("https://clock.internal/reconcile", expect.any(Object))
    expect(send).toHaveBeenCalledOnce()
    expect(markEnqueued).toHaveBeenCalledWith(firstOutboxId, expect.any(String))
  })
})
