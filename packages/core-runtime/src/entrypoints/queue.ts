import type { JobConsumerRoute, JobDisposition, JobPayload, JobPublisher } from "@bob/job-queue"

import { DeliveryResult } from "@bob/contracts/delivery"
import { InboundJob, OutboundJob } from "@bob/contracts/jobs"
import { outboxMessages } from "@bob/db/schema/delivery"
import { completeJob, decodeJobProcessor, retryJob } from "@bob/job-queue"
import { recordDecision, withBobSpan } from "@bob/observability/effect"
import {
  externalParentFromTraceparent,
  injectCurrentTraceparent
} from "@bob/observability/propagation"
import { eq } from "drizzle-orm"
import { Effect, Schema } from "effect"

import type { CoreComposition } from "../composition.ts"
import type { CoreWorkflowTelemetryRunner } from "../process-inbound.ts"

import { publishDeliveryFollowups } from "../modules/delivery/followups.ts"

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

export async function processInboundJob(
  job: InboundJob,
  composition: CoreComposition,
  runTelemetry: CoreWorkflowTelemetryRunner["runPromise"] = Effect.runPromise
) {
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
        const response = yield* withBobSpan(
          {
            name: "bob.coordinator.invoke",
            correlationId,
            feature: "assistant"
          },
          Effect.gen(function* () {
            const headers = yield* injectCurrentTraceparent()
            const traceparent = headers.get("traceparent")
            return yield* promiseEffect(() =>
              (composition.runCoordinator ?? composition.ownerRunCoordinator).run(
                traceparent === null
                  ? { ownerId, job, correlationId }
                  : { ownerId, job, correlationId, traceparent }
              )
            )
          })
        )
        if (!response.ok) return yield* Effect.fail(new Error("owner_coordinator_failed"))
      })
    )
  )
  await runTelemetry(program)
  return completeJob
}

export async function processOutboundDeadLetterJob(
  job: OutboundJob,
  composition: CoreComposition,
  outboundJobs: JobPublisher<OutboundJob>,
  runTelemetry: CoreWorkflowTelemetryRunner["runPromise"] = Effect.runPromise
): Promise<JobDisposition> {
  const correlationId = job.correlationId ?? job.outboxId
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
          (composition.applicationStorage ?? composition.database)
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
        const exhaustedGeneration = job.dispatchGeneration ?? 0
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
        yield* promiseEffect(() => outboundJobs.publish(retryJob, { delayMs: 300_000 }))
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
  return completeJob
}

export async function processDeliveryResultJob(
  result: DeliveryResult,
  deadLetter: boolean,
  composition: CoreComposition,
  outboundJobs: JobPublisher<OutboundJob>,
  runTelemetry: CoreWorkflowTelemetryRunner["runPromise"] = Effect.runPromise
): Promise<JobDisposition> {
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
        if (deadLetter) {
          const [outbox] = yield* promiseEffect(() =>
            (composition.applicationStorage ?? composition.database)
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
            outboundJobs,
            composition.services.delivery,
            readyFollowups,
            correlationId
          )
        )
      })
    )
  )
  await runTelemetry(program)
  return completeJob
}

export async function processInboundDeadLetterJob(
  job: InboundJob,
  composition: CoreComposition,
  inboundJobs: JobPublisher<InboundJob>,
  runTelemetry: CoreWorkflowTelemetryRunner["runPromise"] = Effect.runPromise
): Promise<JobDisposition> {
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
        if (decision !== "recover") return
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
            yield* promiseEffect(() => inboundJobs.publish(retryJob, { delayMs: 300_000 }))
          })
        )
        yield* promiseEffect(() =>
          composition.services.conversations.markEnqueued(job.eventId, new Date().toISOString())
        )
      })
    )
  )
  await runTelemetry(program)
  return completeJob
}

export interface CoreJobQueueNames {
  readonly inbound: string
  readonly inboundDeadLetter: string
  readonly outboundDeadLetter: string
  readonly deliveryResult: string
  readonly deliveryResultDeadLetter: string
}

export function makeCoreJobConsumerRoutes(
  composition: CoreComposition,
  queues: CoreJobQueueNames,
  runTelemetry: CoreWorkflowTelemetryRunner["runPromise"] = Effect.runPromise
): readonly JobConsumerRoute[] {
  const inboundJobs = (composition.jobQueue ?? composition.jobs).inbound
  const outboundJobs = (composition.jobQueue ?? composition.jobs).outbound
  const decodeInbound = {
    decode: (input: JobPayload) => Schema.decodeUnknownSync(InboundJob)(input)
  }
  const decodeOutbound = {
    decode: (input: JobPayload) => Schema.decodeUnknownSync(OutboundJob)(input)
  }
  const decodeDeliveryResult = {
    decode: (input: JobPayload) => Schema.decodeUnknownSync(DeliveryResult)(input)
  }

  return Object.freeze([
    {
      queueName: queues.inbound,
      unexpectedErrorDelayMs: 30_000,
      processor: decodeJobProcessor(
        decodeInbound,
        { process: (job) => processInboundJob(job, composition, runTelemetry) },
        retryJob(30_000)
      )
    },
    {
      queueName: queues.inboundDeadLetter,
      unexpectedErrorDelayMs: 60_000,
      processor: decodeJobProcessor(
        decodeInbound,
        {
          process: (job) => processInboundDeadLetterJob(job, composition, inboundJobs, runTelemetry)
        },
        completeJob
      )
    },
    {
      queueName: queues.outboundDeadLetter,
      unexpectedErrorDelayMs: 60_000,
      processor: decodeJobProcessor(
        decodeOutbound,
        {
          process: (job) =>
            processOutboundDeadLetterJob(job, composition, outboundJobs, runTelemetry)
        },
        completeJob
      )
    },
    {
      queueName: queues.deliveryResult,
      unexpectedErrorDelayMs: 60_000,
      processor: decodeJobProcessor(
        decodeDeliveryResult,
        {
          process: (result) =>
            processDeliveryResultJob(result, false, composition, outboundJobs, runTelemetry)
        },
        retryJob(60_000)
      )
    },
    {
      queueName: queues.deliveryResultDeadLetter,
      unexpectedErrorDelayMs: 60_000,
      processor: decodeJobProcessor(
        decodeDeliveryResult,
        {
          process: (result) =>
            processDeliveryResultJob(result, true, composition, outboundJobs, runTelemetry)
        },
        retryJob(60_000)
      )
    }
  ])
}
