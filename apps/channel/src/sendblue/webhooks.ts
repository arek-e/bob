import type {
  NormalizedInboundEvent,
  NormalizedStatusEvent
} from "@bob/conversations-types/channel"

import { Schema } from "effect"

import { SendblueWebhookPayload } from "./webhook-schema.ts"

export class WebhookValidationError extends Schema.TaggedError<WebhookValidationError>()(
  "WebhookValidationError",
  { message: Schema.String }
) {}

export const decodeWebhookPayload = Schema.decodeUnknownEffect(SendblueWebhookPayload)

export interface NormalizationContext {
  readonly accountId: string
  readonly lineId: string
  readonly outboxId?: string
  readonly attemptId?: string
  readonly correlationId?: string
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
    throw new WebhookValidationError({ message: "Webhook is not an inbound received message" })
  }
  const attachmentCount = payload.media_url.trim().length === 0 ? 0 : 1
  if (payload.content.length === 0 && attachmentCount === 0)
    throw new WebhookValidationError({ message: "Inbound message is empty" })
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
  if (attachmentCount > 0) Object.assign(event, { attachmentCount })
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
    throw new WebhookValidationError({ message: "Webhook is not an outbound status event" })
  }
  const providerStatus = payload.opted_out ? "OPTED_OUT" : payload.status
  if (providerStatus === "RECEIVED") {
    throw new WebhookValidationError({ message: "Webhook has an unsupported outbound status" })
  }
  const status = deliveryStatus[providerStatus]
  if (status === undefined) {
    throw new WebhookValidationError({ message: "Webhook has an unsupported outbound status" })
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
