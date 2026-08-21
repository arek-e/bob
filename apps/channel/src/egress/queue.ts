import type { OutboundJob as OutboundJobValue } from "@bob/core-types/jobs"

import { OutboxClaim, type DeliveryResult } from "@bob/delivery-types/delivery"
import {
  elapsedMilliseconds,
  emitHealth,
  externalParentFromTraceparent,
  injectCurrentTraceparent,
  recordDecision,
  withBobSpan
} from "@bob/observability"
import { Data, Effect, Schema } from "effect"

import { SendblueProvider, type SendOutcome } from "../sendblue/provider.ts"
import { buildSendblueStatusCallback } from "../sendblue/status-callback.ts"
import { SendblueEgress } from "./composition.ts"

const ConflictResponse = Schema.Struct({ disposition: Schema.optionalKey(Schema.String) })

class WorkflowResponseFailure extends Schema.TaggedError<WorkflowResponseFailure>()(
  "WorkflowResponseFailure",
  { response: Schema.Defect() }
) {}

class ProviderOutcomeFailure extends Data.TaggedError("ProviderOutcomeFailure")<{
  readonly outcome: SendOutcome
}> {}

function decodeResponse<A, I, R>(response: Response, schema: Schema.Codec<A, I, R, never>) {
  return Effect.tryPromise(() => response.json()).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(schema))
  )
}

function processDecodedOutboundJob(job: OutboundJobValue) {
  const correlationId = job.correlationId ?? job.outboxId
  const dispatchGeneration = job.dispatchGeneration ?? 0
  const consumeSpan: Parameters<typeof withBobSpan>[0] = {
    name: "bob.outbox.consume",
    correlationId,
    feature: "delivery"
  }
  if (job.enqueuedAt !== undefined) {
    const queueWaitMs = elapsedMilliseconds(job.enqueuedAt)
    if (queueWaitMs !== undefined) Object.assign(consumeSpan, { queueWaitMs })
  }
  const effect = withBobSpan(
    consumeSpan,
    Effect.gen(function* () {
      const egress = yield* SendblueEgress
      const sendblue = yield* SendblueProvider
      const claimAttempt = yield* withBobSpan(
        { name: "bob.outbox.invoke", correlationId, feature: "delivery", outboxId: job.outboxId },
        Effect.gen(function* () {
          const headers = yield* injectCurrentTraceparent({
            "x-bob-caller-token": egress.config.CORE_CALLER_SECRET,
            "x-bob-correlation-id": correlationId,
            "x-bob-dispatch-generation": String(dispatchGeneration)
          })
          const response = yield* Effect.tryPromise(() =>
            egress.core.fetch(
              `https://core.internal/internal/outbox/${encodeURIComponent(job.outboxId)}/claim`,
              { method: "POST", headers }
            )
          )
          if (!response.ok && response.status !== 409) {
            return yield* new WorkflowResponseFailure({ response })
          }
          return response
        })
      ).pipe(Effect.result)
      if (claimAttempt._tag === "Failure") return "retry" as const

      const claimResponse = claimAttempt.success
      if (claimResponse.status === 409) {
        const conflict = yield* decodeResponse(claimResponse, ConflictResponse).pipe(Effect.result)
        if (conflict._tag === "Failure") return "retry" as const
        const active = conflict.success.disposition === "active"
        yield* recordDecision({
          name: "bob.decision.idempotency",
          code: active ? "in_progress" : "replay",
          outcome: "skipped"
        })
        return active ? "retry" : "done"
      }
      if (!claimResponse.ok) return "retry" as const

      const claimResult = yield* decodeResponse(claimResponse, OutboxClaim).pipe(Effect.result)
      if (claimResult._tag === "Failure") return "retry" as const
      const claim = claimResult.success
      yield* recordDecision({
        name: "bob.decision.idempotency",
        code: "allowed",
        outcome: "applied"
      })

      const startedAt = Date.now()
      const outcome = yield* withBobSpan(
        {
          name: "bob.provider.send",
          correlationId: claim.correlationId,
          feature: "delivery"
        },
        Effect.gen(function* () {
          const headers = yield* injectCurrentTraceparent()
          const statusCallback = yield* Effect.try(() =>
            buildSendblueStatusCallback(egress.config.SENDBLUE_STATUS_CALLBACK_URL.toString(), {
              outboxId: claim.outboxId,
              attemptId: claim.attemptId,
              correlationId: claim.correlationId,
              traceparent: headers.get("traceparent")
            })
          )
          const result = yield* sendblue.sendMessage(claim, statusCallback)
          yield* recordDecision({
            name: "bob.state.transition",
            code:
              result.state === "accepted"
                ? "provider_control"
                : result.state === "uncertain"
                  ? "external_unknown"
                  : "provider_failure",
            outcome: result.state === "failed" ? "denied" : "applied"
          })
          if (result.state !== "accepted") {
            return yield* new ProviderOutcomeFailure({ outcome: result })
          }
          return result
        })
      ).pipe(
        Effect.catchTag("ProviderOutcomeFailure", (failure) => Effect.succeed(failure.outcome))
      )
      yield* emitHealth({
        type: "delivery",
        correlationId: claim.correlationId,
        outboxId: claim.outboxId,
        attemptId: claim.attemptId,
        status: outcome.state,
        code: outcome.state === "accepted" ? "accepted" : outcome.code,
        durationMs: Math.max(0, Date.now() - startedAt)
      })

      const occurredAt = new Date().toISOString()
      const enqueuedAt = new Date().toISOString()
      let result: DeliveryResult =
        outcome.state === "accepted"
          ? {
              outboxId: claim.outboxId,
              attemptId: claim.attemptId,
              correlationId: claim.correlationId,
              state: "accepted",
              providerMessageHandle: outcome.providerMessageHandle,
              enqueuedAt,
              occurredAt
            }
          : {
              outboxId: claim.outboxId,
              attemptId: claim.attemptId,
              correlationId: claim.correlationId,
              state: outcome.state,
              errorCode: outcome.code,
              enqueuedAt,
              occurredAt
            }
      const published = yield* withBobSpan(
        {
          name: "bob.delivery_result.publish",
          correlationId: claim.correlationId,
          feature: "delivery"
        },
        Effect.gen(function* () {
          const headers = yield* injectCurrentTraceparent()
          const traceparent = headers.get("traceparent")
          if (traceparent !== null) result = { ...result, traceparent }
          yield* Effect.tryPromise(() => egress.deliveryResults.publish(result))
        })
      ).pipe(
        Effect.as(true),
        Effect.catch(() => Effect.succeed(false))
      )
      if (published) return "done" as const

      const recorded = yield* withBobSpan(
        {
          name: "bob.delivery_result.invoke",
          correlationId: claim.correlationId,
          feature: "delivery",
          outboxId: claim.outboxId,
          deliveryAttemptId: claim.attemptId
        },
        Effect.gen(function* () {
          const headers = yield* injectCurrentTraceparent({
            "content-type": "application/json",
            "x-bob-caller-token": egress.config.CORE_CALLER_SECRET,
            "x-bob-correlation-id": claim.correlationId
          })
          const response = yield* Effect.tryPromise(() =>
            egress.core.fetch(
              `https://core.internal/internal/outbox/${encodeURIComponent(job.outboxId)}/result`,
              { method: "POST", headers, body: JSON.stringify(result) }
            )
          )
          if (!response.ok) return yield* new WorkflowResponseFailure({ response })
          return true
        })
      ).pipe(Effect.catch(() => Effect.succeed(false)))
      return recorded ? "done" : "retry"
    })
  )
  const parent = externalParentFromTraceparent(job.traceparent)
  return parent === undefined ? effect : effect.pipe(Effect.withParentSpan(parent))
}

export function processOutboundJob(input: OutboundJobValue) {
  return processDecodedOutboundJob(input)
}
