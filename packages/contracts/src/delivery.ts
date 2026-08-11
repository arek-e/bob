import { Schema } from "effect"

import { ProviderDeliveryStatus } from "./channel.ts"
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
  correlationId: Uuid,
  claimedAt: IsoDateTime
})

export const DeliveryResult = Schema.Struct({
  outboxId: Uuid,
  attemptId: Uuid,
  state: DeliveryAttemptState,
  providerMessageHandle: Schema.optionalKey(Schema.String),
  errorCode: Schema.optionalKey(Schema.String),
  occurredAt: IsoDateTime
})

export const DeliveryReconciliationRequest = Schema.Struct({
  messageHandle: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256))
})

export const DeliveryReconciliationResult = Schema.Struct({
  messageHandle: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
  status: ProviderDeliveryStatus,
  occurredAt: IsoDateTime
})

export type DeliveryAttemptState = typeof DeliveryAttemptState.Type
export type OutboxClaim = typeof OutboxClaim.Type
export type DeliveryResult = typeof DeliveryResult.Type
export type DeliveryReconciliationRequest = typeof DeliveryReconciliationRequest.Type
export type DeliveryReconciliationResult = typeof DeliveryReconciliationResult.Type
