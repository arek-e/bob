import type {
  JobConsumerRoute,
  JobDisposition,
  JobPayload,
  JobPublisher
} from "@bob/job-queue-types"

import { ConversationStore } from "@bob/conversations-types/store"
import { InboundJob, OutboundJob } from "@bob/core-types/jobs"
import { outboxMessages } from "@bob/db-service/schema/delivery"
import { publishDeliveryFollowups } from "@bob/delivery-service/followups"
import { DeliveryResult } from "@bob/delivery-types/delivery"
import { DeliveryStore } from "@bob/delivery-types/store"
import { completeJob, decodeJobProcessor, retryJob } from "@bob/job-queue-types"
import {
  elapsedMilliseconds,
  recordDecision,
  withBobSpan,
  injectCurrentTraceparent,
  withTraceparent
} from "@bob/observability"
import { AlertStore } from "@bob/operations-types/alerts"
import { eq } from "drizzle-orm"
import { Effect, Schema } from "effect"

import type { CoreComposition } from "../composition.ts"

function promiseEffect<A>(operation: (signal: AbortSignal) => PromiseLike<A>) {
  return Effect.tryPromise({
    try: (signal) => Promise.resolve(operation(signal)),
    catch: (error) => error
  })
}

export async function processInboundJob(job: InboundJob, composition: CoreComposition) {
  const correlationId = job.correlationId ?? job.eventId
  const consumeSpan: Parameters<typeof withBobSpan>[0] = {
    name: "bob.inbound.consume",
    correlationId,
    feature: "assistant"
  }
  if (job.enqueuedAt !== undefined) {
    const queueWaitMs = elapsedMilliseconds(job.enqueuedAt)
    if (queueWaitMs !== undefined) Object.assign(consumeSpan, { queueWaitMs })
  }
  const program = withTraceparent(
    withBobSpan(
      consumeSpan,
      Effect.gen(function* () {
        const conversations = yield* ConversationStore
        const ownerId = yield* conversations.getInboundOwner(job.eventId)
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
              composition.runCoordinator.run(
                traceparent === null
                  ? { ownerId, job, correlationId }
                  : { ownerId, job, correlationId, traceparent }
              )
            )
          })
        )
        if (!response.ok) return yield* Effect.fail(new Error("owner_coordinator_failed"))
      })
    ),
    job.traceparent
  )
  await composition.runtime.runPromise(program)
  return completeJob
}

export async function processOutboundDeadLetterJob(
  job: OutboundJob,
  composition: CoreComposition,
  outboundJobs: JobPublisher<OutboundJob>
): Promise<JobDisposition> {
  const correlationId = job.correlationId ?? job.outboxId
  const publishSpan: Parameters<typeof withBobSpan>[0] = {
    name: "bob.outbox.publish",
    correlationId,
    outboxId: job.outboxId,
    feature: "delivery"
  }
  if (job.dispatchGeneration !== undefined) {
    Object.assign(publishSpan, { queueDispatchGeneration: job.dispatchGeneration })
  }
  if (job.enqueuedAt !== undefined) {
    const queueWaitMs = elapsedMilliseconds(job.enqueuedAt)
    if (queueWaitMs !== undefined) Object.assign(publishSpan, { queueWaitMs })
  }
  const program = withTraceparent(
    withBobSpan(
      publishSpan,
      Effect.gen(function* () {
        const alerts = yield* AlertStore
        const delivery = yield* DeliveryStore
        const [outbox] = yield* composition.applicationStorage
          .select({ userId: outboxMessages.userId })
          .from(outboxMessages)
          .where(eq(outboxMessages.id, job.outboxId))
          .limit(1)
        if (outbox !== undefined) {
          yield* alerts.record({
            ownerId: outbox.userId,
            code: "outbound_exhausted",
            objectType: "outbox_message",
            objectId: job.outboxId,
            idempotencyKey: `alert:outbound-exhausted:${job.outboxId}`
          })
        }
        const exhaustedGeneration = job.dispatchGeneration ?? 0
        const decision = yield* delivery.prepareOutboundRecovery(
          job.outboxId,
          3,
          exhaustedGeneration
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
            ? {
                ...job,
                correlationId,
                dispatchGeneration: decision.dispatchGeneration,
                enqueuedAt: new Date().toISOString()
              }
            : {
                ...job,
                correlationId,
                dispatchGeneration: decision.dispatchGeneration,
                enqueuedAt: new Date().toISOString(),
                traceparent
              }
        yield* promiseEffect(() => outboundJobs.publish(retryJob, { delayMs: 300_000 }))
        yield* delivery.markEnqueued(
          job.outboxId,
          new Date().toISOString(),
          decision.dispatchGeneration
        )
      })
    ),
    job.traceparent
  )
  await composition.runtime.runPromise(program)
  return completeJob
}

export async function processDeliveryResultJob(
  result: DeliveryResult,
  deadLetter: boolean,
  composition: CoreComposition,
  outboundJobs: JobPublisher<OutboundJob>
): Promise<JobDisposition> {
  const correlationId = result.correlationId ?? result.outboxId
  const consumeSpan: Parameters<typeof withBobSpan>[0] = {
    name: "bob.delivery_result.consume",
    correlationId,
    outboxId: result.outboxId,
    deliveryAttemptId: result.attemptId,
    feature: "delivery"
  }
  if (result.enqueuedAt !== undefined) {
    const queueWaitMs = elapsedMilliseconds(result.enqueuedAt)
    if (queueWaitMs !== undefined) Object.assign(consumeSpan, { queueWaitMs })
  }
  const program = withTraceparent(
    withBobSpan(
      consumeSpan,
      Effect.gen(function* () {
        const alerts = yield* AlertStore
        const delivery = yield* DeliveryStore
        if (deadLetter) {
          const [outbox] = yield* composition.applicationStorage
            .select({ userId: outboxMessages.userId })
            .from(outboxMessages)
            .where(eq(outboxMessages.id, result.outboxId))
            .limit(1)
          if (outbox !== undefined) {
            yield* alerts.record({
              ownerId: outbox.userId,
              code: "delivery_result_exhausted",
              objectType: "outbox_message",
              objectId: result.outboxId,
              idempotencyKey: `alert:delivery-result-exhausted:${result.attemptId}`
            })
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
          delivery.recordResult(result)
        )
        yield* publishDeliveryFollowups(outboundJobs, readyFollowups, correlationId)
      })
    ),
    result.traceparent
  )
  await composition.runtime.runPromise(program)
  return completeJob
}

export async function processInboundDeadLetterJob(
  job: InboundJob,
  composition: CoreComposition,
  inboundJobs: JobPublisher<InboundJob>
): Promise<JobDisposition> {
  const correlationId = job.correlationId ?? job.eventId
  const consumeSpan: Parameters<typeof withBobSpan>[0] = {
    name: "bob.inbound.consume",
    correlationId,
    feature: "assistant"
  }
  if (job.enqueuedAt !== undefined) {
    const queueWaitMs = elapsedMilliseconds(job.enqueuedAt)
    if (queueWaitMs !== undefined) Object.assign(consumeSpan, { queueWaitMs })
  }
  const program = withTraceparent(
    withBobSpan(
      consumeSpan,
      Effect.gen(function* () {
        const alerts = yield* AlertStore
        const conversations = yield* ConversationStore
        const ownerId = yield* conversations.getInboundOwner(job.eventId)
        if (ownerId !== undefined) {
          yield* alerts.record({
            ownerId,
            code: "inbound_exhausted",
            objectType: "inbound_event",
            objectId: job.eventId,
            idempotencyKey: `alert:inbound-exhausted:${job.eventId}`
          })
        }
        const decision = yield* conversations.prepareInboundRecovery(job.eventId, 3)
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
                ? { ...job, correlationId, enqueuedAt: new Date().toISOString() }
                : { ...job, correlationId, enqueuedAt: new Date().toISOString(), traceparent }
            yield* promiseEffect(() => inboundJobs.publish(retryJob, { delayMs: 300_000 }))
          })
        )
        yield* conversations.markEnqueued(job.eventId, new Date().toISOString())
      })
    ),
    job.traceparent
  )
  await composition.runtime.runPromise(program)
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
  queues: CoreJobQueueNames
): readonly JobConsumerRoute[] {
  const inboundJobs = composition.jobQueue.inbound
  const outboundJobs = composition.jobQueue.outbound
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
        { process: (job) => processInboundJob(job, composition) },
        retryJob(30_000)
      )
    },
    {
      queueName: queues.inboundDeadLetter,
      unexpectedErrorDelayMs: 60_000,
      processor: decodeJobProcessor(
        decodeInbound,
        {
          process: (job) => processInboundDeadLetterJob(job, composition, inboundJobs)
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
          process: (job) => processOutboundDeadLetterJob(job, composition, outboundJobs)
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
          process: (result) => processDeliveryResultJob(result, false, composition, outboundJobs)
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
          process: (result) => processDeliveryResultJob(result, true, composition, outboundJobs)
        },
        retryJob(60_000)
      )
    }
  ])
}
