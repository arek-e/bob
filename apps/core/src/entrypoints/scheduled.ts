import type { CoreBindings } from "@bob/core-types/bindings"

import { outboxMessages } from "@bob/db-service/schema/delivery"
import { recoverablePendingOutbox } from "@bob/delivery-service/store"
import { DeliveryStore } from "@bob/delivery-types/store"
import {
  withBobRootSpan,
  withBobSpan,
  type BobSpan,
  injectCurrentTraceparent,
  withTraceparent
} from "@bob/observability"
import { Effect } from "effect"

import type { CoreComposer } from "../composition.ts"

export interface ScheduledTraceContext {
  readonly correlationId: string
  readonly scheduledAt?: Date
  readonly traceparent?: string
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

export async function handleScheduled(
  bindings: CoreBindings,
  trace?: ScheduledTraceContext,
  compose?: CoreComposer
): Promise<void> {
  if (compose === undefined) throw new Error("Core composition is required")
  const composition = compose(bindings)
  const outboundJobs = composition.jobQueue.outbound
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
    await composition.runtime.runPromise(
      Effect.flatMap(DeliveryStore, (delivery) => delivery.reconcileExpiredClaims(startedAt))
    )
  })
  for (const task of composition.modules.scheduledTasks) {
    const taskContext = {
      correlationId: scheduledTrace.correlationId,
      scheduledAt: scheduledTrace.scheduledAt ?? new Date(startedAt),
      runPromise: <A, E>(effect: Effect.Effect<A, E>) =>
        composition.runtime.runPromise(withTraceparent(effect, scheduledTrace.traceparent))
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
    pendingOutbox = await Effect.runPromise(
      composition.applicationStorage
        .select({
          id: outboxMessages.id,
          correlationId: outboxMessages.correlationId,
          dispatchGeneration: outboxMessages.dispatchGeneration
        })
        .from(outboxMessages)
        .where(recoverablePendingOutbox)
        .limit(100)
    )
  })
  for (const item of pendingOutbox) {
    await recover(async () => {
      const span: BobSpan = {
        name: "bob.outbox.publish",
        correlationId: item.correlationId,
        feature: "delivery",
        outboxId: item.id
      }
      await composition.runtime.runPromise(
        withBobRootSpan(
          span,
          Effect.gen(function* () {
            const delivery = yield* DeliveryStore
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
            yield* promiseEffect(() => outboundJobs.publish(message))
            yield* delivery.markEnqueued(item.id, new Date().toISOString(), dispatchGeneration)
          })
        )
      )
    })
  }

  const scheduledAt = scheduledTrace.scheduledAt ?? new Date(startedAt)
  if (scheduledAt.getUTCMinutes() % 2 === 0) {
    await recover(async () => {
      const recoveryResponse = await composition.runtime.runPromise(
        withTraceparent(
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
                fetch(`${bindings.CHANNEL_EGRESS_URL}/internal/inbound-reconcile`, {
                  method: "POST",
                  headers,
                  signal
                })
              )
            })
          ),
          scheduledTrace.traceparent
        )
      )
      if (!recoveryResponse.ok) throw new Error("channel_inbound_reconcile_failed")
    })
  }

  if (failures.length > 0) throw new Error("scheduled_recovery_failed")
}
