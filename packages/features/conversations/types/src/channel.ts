import { E164, IsoDateTime, NonEmptyText, Uuid } from "@bob/capabilities-types/shared"
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
  text: Schema.String.check(Schema.isMaxLength(8_000)),
  attachmentCount: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 1 }))
  ),
  service: ProviderMessageService,
  isGroup: Schema.Boolean,
  providerOptedOut: Schema.Boolean,
  receivedAt: IsoDateTime,
  correlationId: Uuid
}).check(
  Schema.makeFilter((event) =>
    event.text.length > 0 || (event.attachmentCount ?? 0) > 0
      ? undefined
      : { path: ["text"], issue: "an inbound event requires text or an attachment" }
  )
)

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
  shouldEnqueue: Schema.Boolean,
  pendingAttachmentOrdinals: Schema.optionalKey(
    Schema.Array(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 0 }))).check(
      Schema.isMaxLength(1)
    )
  )
})

export type NormalizedInboundEvent = typeof NormalizedInboundEvent.Type
export type ProviderMessageService = typeof ProviderMessageService.Type
export type NormalizedStatusEvent = typeof NormalizedStatusEvent.Type
export type InboundAcceptance = typeof InboundAcceptance.Type
