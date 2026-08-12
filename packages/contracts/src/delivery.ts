import { Schema } from "effect"

import { E164, IsoDateTime, ShortText, Uuid } from "./shared.ts"

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
  state: DeliveryAttemptState,
  providerMessageHandle: Schema.optionalKey(Schema.String),
  errorCode: Schema.optionalKey(Schema.String),
  occurredAt: IsoDateTime
})

export type DeliveryAttemptState = typeof DeliveryAttemptState.Type
export type OutboxClaim = typeof OutboxClaim.Type
export type DeliveryResult = typeof DeliveryResult.Type
