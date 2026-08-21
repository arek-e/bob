import { E164, IsoDateTime, ShortText, Uuid } from "@bob/shared-types/shared"
import { Schema } from "effect"

export const DeliveryAttemptState = Schema.Literals([
  "pending",
  "claimed",
  "sending",
  "accepted",
  "delivered",
  "uncertain",
  "failed"
])

export const OutboxClaim = Schema.Struct({
  outboxId: Uuid,
  attemptId: Uuid,
  number: E164,
  fromNumber: E164,
  smsSafeText: ShortText,
  replyToMessageHandle: Schema.optionalKey(Schema.String),
  correlationId: Uuid,
  claimedAt: IsoDateTime
})

export const DeliveryResult = Schema.Struct({
  outboxId: Uuid,
  attemptId: Uuid,
  correlationId: Schema.optionalKey(Uuid),
  traceparent: Schema.optionalKey(
    Schema.String.check(Schema.isPattern(/^00-[0-9a-f]{32}-[0-9a-f]{16}-(00|01)$/))
  ),
  enqueuedAt: Schema.optionalKey(IsoDateTime),
  state: DeliveryAttemptState,
  providerMessageHandle: Schema.optionalKey(Schema.String),
  errorCode: Schema.optionalKey(Schema.String),
  occurredAt: IsoDateTime
})

const DeliveryReconciliationIdentity = {
  outboxId: Uuid,
  attemptId: Uuid,
  correlationId: Uuid
}

export const DeliveryReconciliationRequest = Schema.Union([
  Schema.Struct({
    ...DeliveryReconciliationIdentity,
    providerMessageHandle: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256))
  }),
  Schema.Struct({
    ...DeliveryReconciliationIdentity,
    destinationE164: E164,
    payloadFingerprint: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
    since: IsoDateTime,
    until: IsoDateTime
  })
])

export const DeliveryReconciliationResponse = Schema.Union([
  Schema.Struct({ status: Schema.Literal("resolved"), result: DeliveryResult }),
  Schema.Struct({ status: Schema.Literal("pending") })
])

export type DeliveryAttemptState = typeof DeliveryAttemptState.Type
export type OutboxClaim = typeof OutboxClaim.Type
export type DeliveryResult = typeof DeliveryResult.Type
export type DeliveryReconciliationRequest = typeof DeliveryReconciliationRequest.Type
export type DeliveryReconciliationResponse = typeof DeliveryReconciliationResponse.Type
