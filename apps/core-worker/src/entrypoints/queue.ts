import { DeliveryResult } from "@bob/contracts/delivery"
import { InboundJob, OutboundJob } from "@bob/contracts/jobs"
import { recordDecision, withBobSpan } from "@bob/observability/effect"
import {
  externalParentFromTraceparent,
  injectCurrentTraceparent
} from "@bob/observability/propagation"
import { eq } from "drizzle-orm"
import { Effect, Schema } from "effect"

import type { CoreBindings } from "../bindings.ts"
import type { CoreWorkflowTelemetryRunner } from "../process-inbound.ts"

import { composeCore } from "../composition.ts"
import { publishDeliveryFollowups } from "../modules/delivery/followups.ts"
import { outboxMessages } from "../modules/delivery/schema.ts"

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

export async function handleInboundQueue(
  batch: MessageBatch<unknown>,
  bindings: CoreBindings,
  telemetry?: CoreWorkflowTelemetryRunner,
  compose: typeof composeCore = composeCore
): Promise<void> {
  const composition = compose(bindings)
  const runTelemetry = telemetry?.runPromise ?? Effect.runPromise
  if (batch.queue === bindings.OUTBOUND_DEAD_LETTER_QUEUE_NAME) {
    for (const message of batch.messages) {
      let job: typeof OutboundJob.Type
      try {
        job = Schema.decodeUnknownSync(OutboundJob)(message.body)
      } catch {
        message.ack()
        continue
      }
      try {
        const correlationId = job.correlationId ?? job.outboxId
        const exhaustedGeneration = job.dispatchGeneration ?? 0
        const program = withTraceparentParent(
          job.traceparent,
          withBobSpan(
            {
              name: "bob.outbox.publish",
              correlationId,
              outboxId: job.outboxId,
              feature: "delivery"
            },
            Effect.gen(function* () {
              const [outbox] = yield* promiseEffect(() =>
                composition.database
                  .select({ userId: outboxMessages.userId })
                  .from(outboxMessages)
                  .where(eq(outboxMessages.id, job.outboxId))
                  .limit(1)
              )
              if (outbox !== undefined) {
                yield* promiseEffect(() =>
                  composition.services.alerts.record({
                    ownerId: outbox.userId,
                    code: "outbound_exhausted",
                    objectType: "outbox_message",
                    objectId: job.outboxId,
                    idempotencyKey: `alert:outbound-exhausted:${job.outboxId}`
                  })
                )
              }
              const decision = yield* promiseEffect(() =>
                composition.services.delivery.prepareOutboundRecovery(
                  job.outboxId,
                  3,
                  exhaustedGeneration
                )
              )
              yield* recordDecision({
                name: "bob.decision.idempotency",
                code: decision.status === "recover" ? "allowed" : "limit",
                outcome: decision.status === "recover" ? "allowed" : "skipped"
              })
              if (decision.status !== "recover") return
              const headers = yield* injectCurrentTraceparent()
              const traceparent = headers.get("traceparent")
              const retryJob =
                traceparent === null
                  ? { ...job, correlationId, dispatchGeneration: decision.dispatchGeneration }
                  : {
                      ...job,
                      correlationId,
                      dispatchGeneration: decision.dispatchGeneration,
                      traceparent
                    }
              yield* promiseEffect(() =>
                bindings.OUTBOUND_QUEUE.send(retryJob, { delaySeconds: 300 })
              )
              yield* promiseEffect(() =>
                composition.services.delivery.markEnqueued(
                  job.outboxId,
                  new Date().toISOString(),
                  decision.dispatchGeneration
                )
              )
            })
          )
        )
        await runTelemetry(program)
        message.ack()
      } catch {
        message.retry({ delaySeconds: 60 })
      }
    }
    return
  }
  const isDeliveryResult =
    batch.queue === bindings.DELIVERY_RESULT_QUEUE_NAME ||
    batch.queue === bindings.DELIVERY_RESULT_DEAD_LETTER_QUEUE_NAME

  if (isDeliveryResult) {
    const isDeliveryResultDeadLetter =
      batch.queue === bindings.DELIVERY_RESULT_DEAD_LETTER_QUEUE_NAME
    for (const message of batch.messages) {
      try {
        const result = Schema.decodeUnknownSync(DeliveryResult)(message.body)
        const correlationId = result.correlationId ?? result.outboxId
        const program = withTraceparentParent(
          result.traceparent,
          withBobSpan(
            {
              name: "bob.delivery_result.consume",
              correlationId,
              outboxId: result.outboxId,
              deliveryAttemptId: result.attemptId,
              feature: "delivery"
            },
            Effect.gen(function* () {
              if (isDeliveryResultDeadLetter) {
                const [outbox] = yield* promiseEffect(() =>
                  composition.database
                    .select({ userId: outboxMessages.userId })
                    .from(outboxMessages)
                    .where(eq(outboxMessages.id, result.outboxId))
                    .limit(1)
                )
                if (outbox !== undefined) {
                  yield* promiseEffect(() =>
                    composition.services.alerts.record({
                      ownerId: outbox.userId,
                      code: "delivery_result_exhausted",
                      objectType: "outbox_message",
                      objectId: result.outboxId,
                      idempotencyKey: `alert:delivery-result-exhausted:${result.attemptId}`
                    })
                  )
                }
              }
              const readyFollowups = yield* withBobSpan(
                {
                  name: "bob.delivery_result.record",
                  correlationId,
                  outboxId: result.outboxId,
                  deliveryAttemptId: result.attemptId,
                  feature: "delivery"
                },
                promiseEffect(() => composition.services.delivery.recordResult(result))
              )
              yield* promiseEffect(() =>
                publishDeliveryFollowups(
                  bindings,
                  composition.services.delivery,
                  readyFollowups,
                  correlationId
                )
              )
            })
          )
        )
        await runTelemetry(program)
        message.ack()
      } catch {
        message.retry({ delaySeconds: 60 })
      }
    }
    return
  }

  const isDeadLetter = batch.queue === bindings.INBOUND_DEAD_LETTER_QUEUE_NAME
  for (const message of batch.messages) {
    if (isDeadLetter) {
      let job: typeof InboundJob.Type
      try {
        job = Schema.decodeUnknownSync(InboundJob)(message.body)
      } catch {
        message.ack()
        continue
      }
      try {
        const correlationId = job.correlationId ?? job.eventId
        const program = withTraceparentParent(
          job.traceparent,
          withBobSpan(
            {
              name: "bob.inbound.consume",
              correlationId,
              feature: "assistant"
            },
            Effect.gen(function* () {
              const ownerId = yield* promiseEffect(() =>
                composition.services.conversations.getInboundOwner(job.eventId)
              )
              if (ownerId !== undefined) {
                yield* promiseEffect(() =>
                  composition.services.alerts.record({
                    ownerId,
                    code: "inbound_exhausted",
                    objectType: "inbound_event",
                    objectId: job.eventId,
                    idempotencyKey: `alert:inbound-exhausted:${job.eventId}`
                  })
                )
              }
              const decision = yield* promiseEffect(() =>
                composition.services.conversations.prepareInboundRecovery(job.eventId, 3)
              )
              yield* recordDecision({
                name: "bob.decision.idempotency",
                code: decision === "recover" ? "allowed" : "limit",
                outcome: decision === "recover" ? "allowed" : "skipped"
              })
              if (decision === "recover") {
                yield* withBobSpan(
                  {
                    name: "bob.inbound.publish",
                    correlationId,
                    feature: "assistant"
                  },
                  Effect.gen(function* () {
                    const headers = yield* injectCurrentTraceparent()
                    const traceparent = headers.get("traceparent")
                    const retryJob =
                      traceparent === null
                        ? { ...job, correlationId }
                        : { ...job, correlationId, traceparent }
                    yield* promiseEffect(() =>
                      bindings.INBOUND_QUEUE.send(retryJob, { delaySeconds: 300 })
                    )
                  })
                )
                yield* promiseEffect(() =>
                  composition.services.conversations.markEnqueued(
                    job.eventId,
                    new Date().toISOString()
                  )
                )
              }
            })
          )
        )
        await runTelemetry(program)
        message.ack()
      } catch {
        message.retry({ delaySeconds: 60 })
      }
      continue
    }

    try {
      const job = Schema.decodeUnknownSync(InboundJob)(message.body)
      const correlationId = job.correlationId ?? job.eventId
      const program = withTraceparentParent(
        job.traceparent,
        withBobSpan(
          {
            name: "bob.inbound.consume",
            correlationId,
            feature: "assistant"
          },
          Effect.gen(function* () {
            const ownerId = yield* promiseEffect(() =>
              composition.services.conversations.getInboundOwner(job.eventId)
            )
            if (ownerId === undefined) {
              yield* recordDecision({
                name: "bob.decision.route",
                code: "external_unknown",
                outcome: "skipped"
              })
              return
            }
            yield* recordDecision({
              name: "bob.decision.route",
              code: "allowed",
              outcome: "selected"
            })
            const euCoordinator = bindings.OWNER_RUN_COORDINATOR.jurisdiction("eu")
            const coordinator = euCoordinator.get(euCoordinator.idFromName(ownerId))
            const response = yield* withBobSpan(
              {
                name: "bob.coordinator.invoke",
                correlationId,
                feature: "assistant"
              },
              Effect.gen(function* () {
                const headers = yield* injectCurrentTraceparent({
                  "content-type": "application/json",
                  "x-bob-correlation-id": correlationId
                })
                const traceparent = headers.get("traceparent")
                return yield* promiseEffect(() =>
                  coordinator.fetch("https://coordinator.internal/run", {
                    method: "POST",
                    headers,
                    body: JSON.stringify(
                      traceparent === null
                        ? { ...job, correlationId }
                        : { ...job, correlationId, traceparent }
                    )
                  })
                )
              })
            )
            if (!response.ok) return yield* Effect.fail(new Error("owner_coordinator_failed"))
          })
        )
      )
      await runTelemetry(program)
      message.ack()
    } catch {
      message.retry({ delaySeconds: 30 })
    }
  }
}
