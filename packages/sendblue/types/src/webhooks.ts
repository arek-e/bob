import type { NormalizedInboundEvent, NormalizedStatusEvent } from "@bob/core-types/channel"

import { Schema } from "effect"

const E164 = Schema.String.check(Schema.isPattern(/^\+[1-9]\d{7,14}$/))
const NullableString = Schema.NullOr(Schema.String)
const NullableNumber = Schema.NullOr(Schema.Number)
const NullableBoolean = Schema.NullOr(Schema.Boolean)
const ReplyTo = Schema.Struct({
  message_handle: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
  part_index: Schema.optionalKey(
    Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: 0, maximum: 50 }))
  )
})

export const SendblueWebhookPayload = Schema.Struct({
  accountEmail: Schema.String,
  content: Schema.String.check(Schema.isMaxLength(8_000)),
  is_outbound: Schema.Boolean,
  status: Schema.Literals([
    "RECEIVED",
    "REGISTERED",
    "PENDING",
    "DECLINED",
    "QUEUED",
    "ACCEPTED",
    "SENT",
    "DELIVERED",
    "ERROR",
    "OPTED_OUT"
  ]),
  error_code: NullableNumber,
  error_message: NullableString,
  error_reason: NullableString,
  message_handle: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
  date_sent: Schema.String,
  date_updated: Schema.String,
  from_number: E164,
  number: E164,
  to_number: E164,
  was_downgraded: NullableBoolean,
  plan: Schema.String,
  media_url: Schema.String,
  message_type: Schema.String,
  group_id: Schema.String,
  participants: Schema.Array(E164),
  send_style: Schema.String,
  opted_out: Schema.Boolean,
  error_detail: NullableString,
  sendblue_number: Schema.NullOr(E164),
  service: Schema.String,
  group_display_name: NullableString,
  sender_email: Schema.optionalKey(NullableString),
  seat_id: Schema.optionalKey(NullableString),
  reply_to: Schema.optionalKey(Schema.NullOr(ReplyTo))
})

export type SendblueWebhookPayload = typeof SendblueWebhookPayload.Type

export class WebhookValidationError extends Error {
  readonly code = "invalid_webhook"
  constructor(message = "Sendblue webhook validation failed") {
    super(message)
    this.name = "WebhookValidationError"
  }
}

export async function timingSafeEqual(
  left: string,
  right: string,
  subtle: SubtleCrypto = crypto.subtle
): Promise<boolean> {
  const encoder = new TextEncoder()
  const [leftDigest, rightDigest] = await Promise.all([
    subtle.digest("SHA-256", encoder.encode(left)),
    subtle.digest("SHA-256", encoder.encode(right))
  ])
  const leftBytes = new Uint8Array(leftDigest)
  const rightBytes = new Uint8Array(rightDigest)
  let difference = 0
  for (let index = 0; index < leftBytes.length; index += 1) {
    difference |= leftBytes[index]! ^ rightBytes[index]!
  }
  return difference === 0
}

export function decodeWebhookPayload<Input>(input: Input): SendblueWebhookPayload {
  try {
    return Schema.decodeUnknownSync(SendblueWebhookPayload)(input)
  } catch {
    throw new WebhookValidationError()
  }
}

export interface NormalizationContext {
  readonly accountId: string
  readonly lineId: string
  readonly outboxId?: string
  readonly attemptId?: string
  readonly correlationId?: string
  readonly now?: () => Date
  readonly randomUuid?: () => string
}

function normalizeMessageService(service: string): NormalizedInboundEvent["service"] {
  switch (service.trim().toLowerCase()) {
    case "imessage":
      return "imessage"
    case "sms":
      return "sms"
    case "rcs":
      return "rcs"
    default:
      return "unknown"
  }
}

export function normalizeInbound(
  payload: SendblueWebhookPayload,
  context: NormalizationContext
): NormalizedInboundEvent {
  if (payload.is_outbound || payload.status !== "RECEIVED") {
    throw new WebhookValidationError("Webhook is not an inbound received message")
  }
  if (payload.content.length === 0) {
    throw new WebhookValidationError("Inbound content is empty")
  }
  const randomUuid = context.randomUuid ?? (() => crypto.randomUUID())
  const event: NormalizedInboundEvent = {
    id: randomUuid(),
    accountId: context.accountId,
    lineId: context.lineId,
    messageHandle: payload.message_handle,
    senderE164: payload.from_number,
    destinationE164: payload.to_number,
    text: payload.content,
    service: normalizeMessageService(payload.service),
    isGroup:
      payload.group_id.trim().length > 0 || payload.message_type.toLowerCase().includes("group"),
    providerOptedOut: payload.opted_out,
    receivedAt: new Date(payload.date_sent).toISOString(),
    correlationId: context.correlationId ?? randomUuid()
  }
  if (payload.reply_to !== undefined && payload.reply_to !== null) {
    Object.assign(event, { replyToMessageHandle: payload.reply_to.message_handle })
  }
  return event
}

const deliveryStatus = {
  REGISTERED: "registered",
  PENDING: "pending",
  DECLINED: "declined",
  QUEUED: "queued",
  ACCEPTED: "accepted",
  SENT: "sent",
  DELIVERED: "delivered",
  ERROR: "error",
  OPTED_OUT: "opted_out"
} as const

export function normalizeStatus(
  payload: SendblueWebhookPayload,
  context: NormalizationContext
): NormalizedStatusEvent {
  if (!payload.is_outbound) {
    throw new WebhookValidationError("Webhook is not an outbound status event")
  }
  const providerStatus = payload.opted_out ? "OPTED_OUT" : payload.status
  if (providerStatus === "RECEIVED") {
    throw new WebhookValidationError("Webhook has an unsupported outbound status")
  }
  const status = deliveryStatus[providerStatus]
  if (status === undefined) {
    throw new WebhookValidationError("Webhook has an unsupported outbound status")
  }
  const randomUuid = context.randomUuid ?? (() => crypto.randomUUID())
  const event: NormalizedStatusEvent = {
    id: randomUuid(),
    accountId: context.accountId,
    lineId: context.lineId,
    messageHandle: payload.message_handle,
    destinationE164: payload.to_number,
    providerOptedOut: payload.opted_out,
    status,
    occurredAt: new Date(payload.date_updated).toISOString(),
    correlationId: context.correlationId ?? randomUuid()
  }
  if (context.outboxId !== undefined) Object.assign(event, { outboxId: context.outboxId })
  if (context.attemptId !== undefined) Object.assign(event, { attemptId: context.attemptId })
  return event
}
