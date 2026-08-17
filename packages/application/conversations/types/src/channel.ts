import { E164, IsoDateTime, NonEmptyText, Uuid } from "@bob/shared-types/shared"
import { Schema } from "effect"

export const InboundMessageStatus = Schema.Literals(["RECEIVED"])
export const ProviderDeliveryStatus = Schema.Literals([
  "registered",
  "pending",
  "declined",
  "queued",
  "accepted",
  "sent",
  "delivered",
  "error",
  "opted_out"
])
export const ProviderMessageService = Schema.Literals(["imessage", "sms", "rcs", "unknown"])

export const NormalizedInboundEvent = Schema.Struct({
  id: Uuid,
  accountId: NonEmptyText,
  lineId: NonEmptyText,
  messageHandle: NonEmptyText,
  replyToMessageHandle: Schema.optionalKey(NonEmptyText),
  senderE164: E164,
  destinationE164: E164,
  text: NonEmptyText,
  service: ProviderMessageService,
  isGroup: Schema.Boolean,
  providerOptedOut: Schema.Boolean,
  receivedAt: IsoDateTime,
  correlationId: Uuid
})

export const NormalizedStatusEvent = Schema.Struct({
  id: Uuid,
  accountId: NonEmptyText,
  lineId: NonEmptyText,
  messageHandle: NonEmptyText,
  destinationE164: E164,
  providerOptedOut: Schema.Boolean,
  status: ProviderDeliveryStatus,
  outboxId: Schema.optionalKey(Uuid),
  attemptId: Schema.optionalKey(Uuid),
  occurredAt: IsoDateTime,
  correlationId: Uuid
})

export const InboundAcceptance = Schema.Struct({
  eventId: Uuid,
  duplicate: Schema.Boolean,
  shouldEnqueue: Schema.Boolean
})

export type NormalizedInboundEvent = typeof NormalizedInboundEvent.Type
export type ProviderMessageService = typeof ProviderMessageService.Type
export type NormalizedStatusEvent = typeof NormalizedStatusEvent.Type
export type InboundAcceptance = typeof InboundAcceptance.Type
