import { parseTraceparent } from "@bob/observability/propagation"
import { makeCaptureTelemetry } from "@bob/observability/testing"
import { Effect } from "effect"
import { beforeEach, describe, expect, it, vi } from "vitest"

import type { CoreBindings } from "../src/bindings.ts"
import type { CoreComposition } from "../src/composition.ts"

import { handleScheduled } from "../src/entrypoints/scheduled.ts"

const compositionHarness = vi.hoisted(() => ({
  current: undefined as CoreComposition | undefined
}))

vi.mock("../src/composition.ts", () => ({
  composeCore: () => compositionHarness.current
}))

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
    compositionHarness.current = {
      config: { OWNER_ID: scheduledCorrelationId },
      database: { select, update },
      services: {
        delivery: {
          reconcileExpiredClaims: vi.fn(async () => 0),
          markEnqueued
        },
        reminders: {
          releaseExpiredClaims: vi.fn(async () => 0),
          markExpiredResponseDeadlines: vi.fn(async () => 0)
        }
      }
    } as unknown as CoreComposition
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
    const bindings = {
      REMINDER_CLOCK: { jurisdiction: vi.fn(() => namespace) },
      OUTBOUND_QUEUE: { send: async (job: unknown) => published.push(job) },
      SENDBLUE_EGRESS_URL: "https://egress.example.invalid",
      EGRESS_CALLER_SECRET: "c".repeat(64)
    } as unknown as CoreBindings

    await handleScheduled(
      bindings,
      {
        correlationId: scheduledCorrelationId,
        traceparent,
        scheduledAt: new Date("2026-08-13T10:32:00.000Z")
      },
      captureRunner(telemetry)
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
      "bob.reminder.occurrence_id": occurrenceId
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
})
