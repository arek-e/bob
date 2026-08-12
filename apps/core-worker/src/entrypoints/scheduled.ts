import { withBobRootSpan, withBobSpan, type BobSpan } from "@bob/observability/effect"
import {
  externalParentFromTraceparent,
  injectCurrentTraceparent
} from "@bob/observability/propagation"
import { and, eq, isNull } from "drizzle-orm"
import { Effect, Schema } from "effect"

import type { CoreBindings } from "../bindings.ts"

import { composeCore } from "../composition.ts"
import { outboxMessages } from "../modules/delivery/schema.ts"
import { recoverablePendingOutbox } from "../modules/delivery/store.ts"
import { schedulerOutbox } from "../modules/reminders/schema.ts"

export interface ScheduledTraceContext {
  readonly correlationId: string
  readonly traceparent?: string
}

export interface ScheduledTelemetryRunner {
  readonly runPromise: <A, E>(effect: Effect.Effect<A, E>) => Promise<A>
}

interface PendingOutbox {
  readonly id: string
  readonly correlationId: string
  readonly actionTargetType: string | null
  readonly actionTargetId: string | null
}

function promiseEffect<A>(operation: (signal: AbortSignal) => PromiseLike<A>) {
  return Effect.tryPromise({
    try: (signal) => Promise.resolve(operation(signal)),
    catch: (error) => error
  })
}

function withTraceparentParent<A, E>(
  traceparent: string | undefined,
  effect: Effect.Effect<A, E>
): Effect.Effect<A, E> {
  const parent = externalParentFromTraceparent(traceparent)
  return parent === undefined ? effect : Effect.withParentSpan(effect, parent)
}

function safeUuid(value: string | null): string | undefined {
  if (value === null) return undefined
  try {
    return Schema.decodeUnknownSync(Schema.String.check(Schema.isUUID()))(value)
  } catch {
    return undefined
  }
}

function reminderOccurrence(item: PendingOutbox): string | undefined {
  return item.actionTargetType === "reminder_occurrence" ? safeUuid(item.actionTargetId) : undefined
}

export async function handleScheduled(
  bindings: CoreBindings,
  trace?: ScheduledTraceContext,
  telemetry?: ScheduledTelemetryRunner
): Promise<void> {
  const composition = composeCore(bindings)
  const runTelemetry = telemetry?.runPromise ?? Effect.runPromise
  const scheduledTrace: ScheduledTraceContext = trace ?? { correlationId: crypto.randomUUID() }
  const startedAt = new Date().toISOString()
  await composition.services.delivery.reconcileExpiredClaims(startedAt)
  await composition.services.reminders.releaseExpiredClaims(startedAt)
  await composition.services.reminders.markExpiredResponseDeadlines(startedAt)
  const euClock = bindings.REMINDER_CLOCK.jurisdiction("eu")
  const clock = euClock.get(euClock.idFromName(composition.config.OWNER_ID))

  const pendingScheduler = await composition.database
    .select()
    .from(schedulerOutbox)
    .where(isNull(schedulerOutbox.processedAt))
    .orderBy(schedulerOutbox.createdAt)
    .limit(100)
  for (const item of pendingScheduler) {
    const response = await runTelemetry(
      withTraceparentParent(
        scheduledTrace.traceparent,
        withBobSpan(
          {
            name: "bob.reminder.invoke",
            correlationId: scheduledTrace.correlationId,
            feature: "reminders"
          },
          Effect.gen(function* () {
            const headers = yield* injectCurrentTraceparent({
              "content-type": "application/json",
              "x-bob-correlation-id": scheduledTrace.correlationId
            })
            return yield* promiseEffect(() =>
              clock.fetch("https://clock.internal/command", {
                method: "POST",
                headers,
                body: JSON.stringify({
                  id: item.id,
                  reminderId: item.reminderId,
                  scheduleRevision: item.scheduleRevision,
                  command: item.command
                })
              })
            )
          })
        )
      )
    )
    if (!response.ok) throw new Error("reminder_clock_command_failed")
    await composition.database
      .update(schedulerOutbox)
      .set({ processedAt: new Date().toISOString() })
      .where(and(eq(schedulerOutbox.id, item.id), isNull(schedulerOutbox.processedAt)))
  }

  const clockResponse = await runTelemetry(
    withTraceparentParent(
      scheduledTrace.traceparent,
      withBobSpan(
        {
          name: "bob.reminder.invoke",
          correlationId: scheduledTrace.correlationId,
          feature: "reminders"
        },
        Effect.gen(function* () {
          const headers = yield* injectCurrentTraceparent({
            "x-bob-correlation-id": scheduledTrace.correlationId
          })
          return yield* promiseEffect(() =>
            clock.fetch("https://clock.internal/reconcile", { method: "POST", headers })
          )
        })
      )
    )
  )
  if (!clockResponse.ok) throw new Error("reminder_clock_reconcile_failed")

  const pendingOutbox = await composition.database
    .select({
      id: outboxMessages.id,
      correlationId: outboxMessages.correlationId,
      actionTargetType: outboxMessages.actionTargetType,
      actionTargetId: outboxMessages.actionTargetId
    })
    .from(outboxMessages)
    .where(recoverablePendingOutbox)
    .limit(100)
  for (const item of pendingOutbox) {
    const occurrenceId = reminderOccurrence(item)
    const span: BobSpan = {
      name: "bob.outbox.publish",
      correlationId: item.correlationId,
      feature: item.actionTargetType === "reminder_occurrence" ? "reminders" : "assistant",
      outboxId: item.id,
      ...(occurrenceId === undefined ? {} : { reminderOccurrenceId: occurrenceId })
    }
    await runTelemetry(
      withBobRootSpan(
        span,
        Effect.gen(function* () {
          const headers = yield* injectCurrentTraceparent()
          const traceparent = headers.get("traceparent")
          yield* promiseEffect(() =>
            bindings.OUTBOUND_QUEUE.send({
              outboxId: item.id,
              correlationId: item.correlationId,
              ...(traceparent === null ? {} : { traceparent })
            })
          )
          yield* promiseEffect(() =>
            composition.services.delivery.markEnqueued(item.id, new Date().toISOString())
          )
        })
      )
    )
  }
}
