import { withBobRootSpan, withBobSpan, type BobSpan } from "@bob/observability/effect"
import {
  externalParentFromTraceparent,
  injectCurrentTraceparent
} from "@bob/observability/propagation"
import { Effect } from "effect"

import type { CoreBindings } from "../bindings.ts"

import { composeCore } from "../composition.ts"
import { outboxMessages } from "../modules/delivery/schema.ts"
import { recoverablePendingOutbox } from "../modules/delivery/store.ts"

export interface ScheduledTraceContext {
  readonly correlationId: string
  readonly scheduledAt?: Date
  readonly traceparent?: string
}

export interface ScheduledTelemetryRunner {
  readonly runPromise: <A, E>(effect: Effect.Effect<A, E>) => Promise<A>
}

interface PendingOutbox {
  readonly id: string
  readonly correlationId: string
  readonly dispatchGeneration: number
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

export async function handleScheduled(
  bindings: CoreBindings,
  trace?: ScheduledTraceContext,
  telemetry?: ScheduledTelemetryRunner,
  compose: typeof composeCore = composeCore
): Promise<void> {
  const composition = compose(bindings)
  const runTelemetry = telemetry?.runPromise ?? Effect.runPromise
  const scheduledTrace: ScheduledTraceContext = trace ?? { correlationId: crypto.randomUUID() }
  const startedAt = new Date().toISOString()
  const failures: unknown[] = []
  async function recover(operation: () => Promise<void>): Promise<void> {
    try {
      await operation()
    } catch (error) {
      failures.push(error)
    }
  }

  await recover(async () => {
    await composition.services.delivery.reconcileExpiredClaims(startedAt)
  })
  for (const task of composition.runtime.scheduledTasks) {
    const taskContext = {
      correlationId: scheduledTrace.correlationId,
      scheduledAt: scheduledTrace.scheduledAt ?? new Date(startedAt),
      runPromise: <A, E>(effect: Effect.Effect<A, E>) =>
        runTelemetry(withTraceparentParent(scheduledTrace.traceparent, effect))
    }
    await recover(() =>
      task.run(
        scheduledTrace.traceparent === undefined
          ? taskContext
          : { ...taskContext, traceparent: scheduledTrace.traceparent }
      )
    )
  }

  let pendingOutbox: PendingOutbox[] = []
  await recover(async () => {
    pendingOutbox = await composition.database
      .select({
        id: outboxMessages.id,
        correlationId: outboxMessages.correlationId,
        dispatchGeneration: outboxMessages.dispatchGeneration
      })
      .from(outboxMessages)
      .where(recoverablePendingOutbox)
      .limit(100)
  })
  for (const item of pendingOutbox) {
    await recover(async () => {
      const span: BobSpan = {
        name: "bob.outbox.publish",
        correlationId: item.correlationId,
        feature: "delivery",
        outboxId: item.id
      }
      await runTelemetry(
        withBobRootSpan(
          span,
          Effect.gen(function* () {
            const headers = yield* injectCurrentTraceparent()
            const traceparent = headers.get("traceparent")
            const dispatchGeneration = item.dispatchGeneration ?? 0
            const message =
              traceparent === null
                ? {
                    outboxId: item.id,
                    dispatchGeneration,
                    correlationId: item.correlationId
                  }
                : {
                    outboxId: item.id,
                    dispatchGeneration,
                    correlationId: item.correlationId,
                    traceparent
                  }
            yield* promiseEffect(() => bindings.OUTBOUND_QUEUE.send(message))
            yield* promiseEffect(() =>
              composition.services.delivery.markEnqueued(
                item.id,
                new Date().toISOString(),
                dispatchGeneration
              )
            )
          })
        )
      )
    })
  }

  const scheduledAt = scheduledTrace.scheduledAt ?? new Date(startedAt)
  if (scheduledAt.getUTCMinutes() % 2 === 0) {
    await recover(async () => {
      const recoveryResponse = await runTelemetry(
        withTraceparentParent(
          scheduledTrace.traceparent,
          withBobSpan(
            {
              name: "bob.inbound.reconcile",
              correlationId: scheduledTrace.correlationId,
              feature: "assistant"
            },
            Effect.gen(function* () {
              const headers = yield* injectCurrentTraceparent({
                "x-bob-caller-token": bindings.EGRESS_CALLER_SECRET,
                "x-bob-correlation-id": scheduledTrace.correlationId
              })
              return yield* promiseEffect((signal) =>
                fetch(`${bindings.SENDBLUE_EGRESS_URL}/internal/inbound-reconcile`, {
                  method: "POST",
                  headers,
                  signal
                })
              )
            })
          )
        )
      )
      if (!recoveryResponse.ok) throw new Error("sendblue_inbound_reconcile_failed")
    })
  }

  if (failures.length > 0) throw new Error("scheduled_recovery_failed")
}
