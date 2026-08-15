import type { SendOutcome } from "@bob/sendblue/client"

import { OutboxClaim, type DeliveryResult } from "@bob/contracts/delivery"
import { OutboundJob, type OutboundJob as OutboundJobValue } from "@bob/contracts/jobs"
import { flushCloudflareTelemetry } from "@bob/observability/cloudflare"
import { recordDecision, withBobSpan } from "@bob/observability/effect"
import { observeHealth } from "@bob/observability/events"
import {
  externalParentFromTraceparent,
  injectCurrentTraceparent
} from "@bob/observability/propagation"
import { buildSendblueStatusCallback } from "@bob/sendblue/status-callback"
import { Effect, Schema } from "effect"

import type { EgressBindings } from "../bindings.ts"

import { composeEgress } from "../composition.ts"

type EgressComposition = ReturnType<typeof composeEgress>

class ProviderOutcomeFailure {
  readonly _tag = "ProviderOutcomeFailure"

  constructor(readonly outcome: Exclude<SendOutcome, { readonly state: "accepted" }>) {}
}

class CoreResponseFailure {
  readonly _tag = "CoreResponseFailure"

  constructor(readonly response: Response) {}
}

function processOutboundJobEffect(job: OutboundJobValue, composition: EgressComposition) {
  const correlationId = job.correlationId ?? job.outboxId
  return withBobSpan(
    { name: "bob.outbox.consume", correlationId, feature: "delivery" },
    Effect.gen(function* () {
      const claimResponse = yield* withBobSpan(
        { name: "bob.outbox.invoke", correlationId, feature: "delivery", outboxId: job.outboxId },
        Effect.gen(function* () {
          const headers = yield* injectCurrentTraceparent({
            "x-bob-caller-token": composition.config.CORE_CALLER_SECRET,
            "x-bob-correlation-id": correlationId
          })
          const response = yield* Effect.tryPromise(() =>
            composition.ports.core.fetch(
              `https://core.internal/internal/outbox/${encodeURIComponent(job.outboxId)}/claim`,
              { method: "POST", headers }
            )
          )
          if (!response.ok && response.status !== 409) {
            return yield* Effect.fail(new CoreResponseFailure(response))
          }
          return response
        })
      ).pipe(Effect.catchTag("CoreResponseFailure", (failure) => Effect.succeed(failure.response)))
      if (claimResponse.status === 409) {
        const conflict = yield* Effect.tryPromise(async () =>
          Schema.decodeUnknownSync(ConflictResponse)(await claimResponse.json())
        )
        const active = conflict.disposition === "active"
        yield* recordDecision({
          name: "bob.decision.idempotency",
          code: active ? "in_progress" : "replay",
          outcome: "skipped"
        })
        return active ? "retry" : "done"
      }
      if (!claimResponse.ok) return "retry"
      const claim = yield* Effect.tryPromise(async () =>
        Schema.decodeUnknownSync(OutboxClaim)(await claimResponse.json())
      )
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
          const result = yield* Effect.tryPromise(() =>
            composition.ports.sendblue.sendMessage(
              claim,
              buildSendblueStatusCallback(composition.config.SENDBLUE_STATUS_CALLBACK_URL, {
                outboxId: claim.outboxId,
                attemptId: claim.attemptId,
                correlationId: claim.correlationId,
                traceparent: headers.get("traceparent")
              })
            )
          )
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
            return yield* Effect.fail(new ProviderOutcomeFailure(result))
          }
          return result
        })
      ).pipe(
        Effect.catchTag("ProviderOutcomeFailure", (failure) => Effect.succeed(failure.outcome))
      )
      yield* Effect.promise(() =>
        observeHealth(composition.events, {
          type: "delivery",
          correlationId: claim.correlationId,
          outboxId: claim.outboxId,
          attemptId: claim.attemptId,
          status: outcome.state,
          code: outcome.state === "accepted" ? "accepted" : outcome.code,
          durationMs: Math.max(0, Date.now() - startedAt)
        })
      )

      const occurredAt = new Date().toISOString()
      let result: DeliveryResult =
        outcome.state === "accepted"
          ? {
              outboxId: claim.outboxId,
              attemptId: claim.attemptId,
              correlationId: claim.correlationId,
              state: "accepted",
              providerMessageHandle: outcome.providerMessageHandle,
              occurredAt
            }
          : {
              outboxId: claim.outboxId,
              attemptId: claim.attemptId,
              correlationId: claim.correlationId,
              state: outcome.state,
              errorCode: outcome.code,
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
          yield* Effect.tryPromise(() => composition.ports.deliveryResults.send(result))
        })
      ).pipe(
        Effect.as(true),
        Effect.catch(() => Effect.succeed(false))
      )
      if (published) return "done"

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
            "x-bob-caller-token": composition.config.CORE_CALLER_SECRET,
            "x-bob-correlation-id": claim.correlationId
          })
          const response = yield* Effect.tryPromise(() =>
            composition.ports.core.fetch(
              `https://core.internal/internal/outbox/${encodeURIComponent(job.outboxId)}/result`,
              { method: "POST", headers, body: JSON.stringify(result) }
            )
          )
          if (!response.ok) return yield* Effect.fail(new CoreResponseFailure(response))
          return true
        })
      ).pipe(Effect.catch(() => Effect.succeed(false)))
      return recorded ? "done" : "retry"
    })
  )
}

async function runOutboundJob(
  job: OutboundJobValue,
  composition: EgressComposition
): Promise<"done" | "retry"> {
  const effect = processOutboundJobEffect(job, composition)
  const parent = externalParentFromTraceparent(job.traceparent)
  const continued = parent === undefined ? effect : effect.pipe(Effect.withParentSpan(parent))
  return Effect.runPromise(continued.pipe(Effect.provide(composition.layer)))
}

function scheduleFlush(
  composition: EgressComposition,
  context: ExecutionContext | undefined
): void {
  if (context === undefined) return
  try {
    context.waitUntil(Effect.runPromise(flushCloudflareTelemetry(composition.processor)))
  } catch {
    // Telemetry must not change Queue acknowledgement.
  }
}

export async function processOutboundJob<Input>(
  input: Input,
  bindings: EgressBindings,
  context?: ExecutionContext
): Promise<"done" | "retry"> {
  const job = Schema.decodeUnknownSync(OutboundJob)(input)
  const composition = composeEgress(bindings)
  try {
    return await runOutboundJob(job, composition)
  } finally {
    scheduleFlush(composition, context)
  }
}

export async function handleOutboundQueue(
  batch: MessageBatch<unknown>,
  bindings: EgressBindings,
  context: ExecutionContext
): Promise<void> {
  let composition: EgressComposition
  try {
    composition = composeEgress(bindings)
  } catch {
    for (const message of batch.messages) message.retry({ delaySeconds: 30 })
    return
  }
  try {
    for (const message of batch.messages) {
      try {
        const job = Schema.decodeUnknownSync(OutboundJob)(message.body)
        const outcome = await runOutboundJob(job, composition)
        if (outcome === "done") message.ack()
        else message.retry({ delaySeconds: 30 })
      } catch {
        message.retry({ delaySeconds: 30 })
      }
    }
  } finally {
    scheduleFlush(composition, context)
  }
}
const ConflictResponse = Schema.Struct({ disposition: Schema.optionalKey(Schema.String) })
