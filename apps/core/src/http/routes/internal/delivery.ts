import { NormalizedStatusEvent } from "@bob/conversations-types/channel"
import { publishDeliveryFollowups } from "@bob/delivery-service/followups"
import { DeliveryResult } from "@bob/delivery-types/delivery"
import { DeliveryStore } from "@bob/delivery-types/store"
import { elapsedMilliseconds, withBobSpan, type BobSpan, withTraceparent } from "@bob/observability"
import { Effect, Schema } from "effect"

import type { HttpRouteContext } from "../../context.ts"

import { json } from "../../response.ts"

function deliveryResultSpan(
  name: "bob.delivery_result.accept" | "bob.delivery_result.record",
  event: typeof NormalizedStatusEvent.Type
): BobSpan {
  const common = { name, correlationId: event.correlationId, feature: "delivery" as const }
  const outboxId = event.outboxId
  const deliveryAttemptId = event.attemptId
  if (outboxId === undefined && deliveryAttemptId === undefined) return common
  if (outboxId === undefined && deliveryAttemptId !== undefined) {
    return { ...common, deliveryAttemptId }
  }
  if (outboxId !== undefined && deliveryAttemptId === undefined) return { ...common, outboxId }
  if (outboxId === undefined || deliveryAttemptId === undefined) return common
  return { ...common, outboxId, deliveryAttemptId }
}

export async function handleInternalDelivery(
  context: HttpRouteContext
): Promise<Response | undefined> {
  if (context.request.method === "POST" && context.url.pathname === "/internal/status") {
    const event = Schema.decodeUnknownSync(NormalizedStatusEvent)(await context.readJson())
    let providerAcceptedToDeliveredMs: number | undefined
    if (
      event.status === "delivered" &&
      event.outboxId !== undefined &&
      event.attemptId !== undefined
    ) {
      try {
        const timing = await context.composition.runtime.runPromise(
          Effect.flatMap(DeliveryStore, (delivery) =>
            delivery.attemptTiming(event.outboxId!, event.attemptId!)
          )
        )
        if (timing?.state === "accepted") {
          providerAcceptedToDeliveredMs = elapsedMilliseconds(timing.updatedAt, event.occurredAt)
        }
      } catch {
        // A timing read must never block provider status reconciliation.
      }
    }
    const recordSpan = deliveryResultSpan("bob.delivery_result.record", event)
    if (providerAcceptedToDeliveredMs !== undefined) {
      Object.assign(recordSpan, { providerAcceptedToDeliveredMs })
    }
    const readyFollowups = await context.runTelemetry(
      withTraceparent(
        withBobSpan(
          deliveryResultSpan("bob.delivery_result.accept", event),
          withBobSpan(
            recordSpan,
            Effect.flatMap(DeliveryStore, (delivery) => delivery.recordProviderEvent(event))
          )
        ),
        context.request.headers.get("traceparent")
      )
    )
    await context.composition.runtime.runPromise(
      publishDeliveryFollowups(context.jobQueue().outbound, readyFollowups, event.correlationId)
    )
    return json({ ok: true })
  }

  const outboxClaim = context.url.pathname.match(/^\/internal\/outbox\/([^/]+)\/claim$/)
  if (context.request.method === "POST" && outboxClaim !== null) {
    const outboxId = Schema.decodeUnknownSync(Schema.String.check(Schema.isUUID()))(
      decodeURIComponent(outboxClaim[1]!)
    )
    const suppliedCorrelation = context.request.headers.get("x-bob-correlation-id")
    const correlationId =
      suppliedCorrelation === null
        ? outboxId
        : Schema.decodeUnknownSync(Schema.String.check(Schema.isUUID()))(suppliedCorrelation)
    const dispatchGeneration = Schema.decodeUnknownSync(
      Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
    )(Number(context.request.headers.get("x-bob-dispatch-generation") ?? "0"))
    const claim = await context.runTelemetry(
      withTraceparent(
        withBobSpan(
          {
            name: "bob.outbox.claim",
            correlationId,
            outboxId,
            feature: "delivery"
          },
          Effect.flatMap(DeliveryStore, (delivery) =>
            delivery.claimOutbox(outboxId, 60_000, dispatchGeneration)
          )
        ),
        context.request.headers.get("traceparent")
      )
    )
    return claim === undefined
      ? json(
          {
            claim: null,
            disposition: await context.composition.runtime.runPromise(
              Effect.flatMap(DeliveryStore, (delivery) =>
                delivery.outboxDisposition(outboxId, dispatchGeneration)
              )
            )
          },
          409
        )
      : json(claim)
  }

  const outboxResult = context.url.pathname.match(/^\/internal\/outbox\/([^/]+)\/result$/)
  if (context.request.method === "POST" && outboxResult !== null) {
    const result = Schema.decodeUnknownSync(DeliveryResult)(await context.readJson())
    if (result.outboxId !== decodeURIComponent(outboxResult[1]!)) {
      return json({ code: "id_mismatch" }, 400)
    }
    const readyFollowups = await context.runTelemetry(
      withTraceparent(
        withBobSpan(
          {
            name: "bob.delivery_result.accept",
            correlationId: result.correlationId ?? result.outboxId,
            outboxId: result.outboxId,
            deliveryAttemptId: result.attemptId,
            feature: "delivery"
          },
          withBobSpan(
            {
              name: "bob.delivery_result.record",
              correlationId: result.correlationId ?? result.outboxId,
              outboxId: result.outboxId,
              deliveryAttemptId: result.attemptId,
              feature: "delivery"
            },
            Effect.flatMap(DeliveryStore, (delivery) => delivery.recordResult(result))
          )
        ),
        context.request.headers.get("traceparent")
      )
    )
    await context.composition.runtime.runPromise(
      publishDeliveryFollowups(
        context.jobQueue().outbound,
        readyFollowups,
        result.correlationId ?? result.outboxId
      )
    )
    return json({ ok: true })
  }

  return undefined
}
