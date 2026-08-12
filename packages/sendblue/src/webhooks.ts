import {
  NormalizedInboundEvent as NormalizedInboundEventSchema,
  NormalizedStatusEvent as NormalizedStatusEventSchema,
  type NormalizedInboundEvent,
  type NormalizedStatusEvent
} from "@bob/contracts/channel"
import { Schema } from "effect"

const E164 = Schema.String.check(Schema.isPattern(/^\+[1-9]\d{7,14}$/))
const NullableString = Schema.NullOr(Schema.String)
const NullableNumber = Schema.NullOr(Schema.Number)
const NullableBoolean = Schema.NullOr(Schema.Boolean)

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
  seat_id: Schema.optionalKey(NullableString)
})

export type SendblueWebhookPayload = typeof SendblueWebhookPayload.Type

export class WebhookValidationError extends Error {
  readonly code = "invalid_webhook"
  constructor(message = "Sendblue webhook validation failed") {
    super(message)
    this.name = "WebhookValidationError"
  }
}

export type WebhookRejectionCode =
  | "unauthorized"
  | "not_found"
  | "not_allowed"
  | "unknown_line"
  | "invalid_webhook"

export class WebhookRejection extends Error {
  constructor(
    readonly code: WebhookRejectionCode,
    readonly status: 400 | 401 | 403 | 404
  ) {
    super(`Sendblue webhook rejected: ${code}`)
    this.name = "WebhookRejection"
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

export function decodeWebhookPayload(input: unknown): SendblueWebhookPayload {
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

export interface WebhookIntakePolicy {
  readonly signingSecret: string
  readonly accountId: string
  readonly lineId: string
  readonly fromNumber: string
  readonly allowedUserNumber: string
}

export interface WebhookStatusMetadata {
  readonly outboxId?: string
  readonly attemptId?: string
}

export interface WebhookIntakeInput {
  readonly pathname: string
  readonly suppliedSecret: string | null
  readonly readPayload: () => Promise<unknown>
  readonly policy: WebhookIntakePolicy
  readonly statusMetadata?: WebhookStatusMetadata
}

export type AcceptedWebhook =
  | { readonly kind: "inbound"; readonly event: NormalizedInboundEvent }
  | { readonly kind: "status"; readonly event: NormalizedStatusEvent }

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
  return Schema.decodeUnknownSync(NormalizedInboundEventSchema)({
    id: randomUuid(),
    accountId: context.accountId,
    lineId: context.lineId,
    messageHandle: payload.message_handle,
    senderE164: payload.from_number,
    destinationE164: payload.to_number,
    text: payload.content,
    providerOptedOut: payload.opted_out,
    receivedAt: new Date(payload.date_sent).toISOString(),
    correlationId: context.correlationId ?? randomUuid()
  })
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
  const status =
    deliveryStatus[
      payload.opted_out ? "OPTED_OUT" : (payload.status as keyof typeof deliveryStatus)
    ]
  if (status === undefined) {
    throw new WebhookValidationError("Webhook has an unsupported outbound status")
  }
  const randomUuid = context.randomUuid ?? (() => crypto.randomUUID())
  return Schema.decodeUnknownSync(NormalizedStatusEventSchema)({
    id: randomUuid(),
    accountId: context.accountId,
    lineId: context.lineId,
    messageHandle: payload.message_handle,
    destinationE164: payload.to_number,
    providerOptedOut: payload.opted_out,
    status,
    ...(context.outboxId === undefined ? {} : { outboxId: context.outboxId }),
    ...(context.attemptId === undefined ? {} : { attemptId: context.attemptId }),
    occurredAt: new Date(payload.date_updated).toISOString(),
    correlationId: context.correlationId ?? randomUuid()
  })
}

export async function acceptSendblueWebhook(input: WebhookIntakeInput): Promise<AcceptedWebhook> {
  if (
    input.suppliedSecret === null ||
    !(await timingSafeEqual(input.suppliedSecret, input.policy.signingSecret))
  ) {
    throw new WebhookRejection("unauthorized", 401)
  }
  if (input.pathname !== "/webhooks/receive" && input.pathname !== "/webhooks/outbound") {
    throw new WebhookRejection("not_found", 404)
  }

  let payload: SendblueWebhookPayload
  try {
    payload = decodeWebhookPayload(await input.readPayload())
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof WebhookValidationError) {
      throw new WebhookRejection("invalid_webhook", 400)
    }
    throw error
  }

  const context = {
    accountId: input.policy.accountId,
    lineId: input.policy.lineId
  }
  try {
    if (input.pathname === "/webhooks/receive") {
      if (
        payload.to_number !== input.policy.fromNumber ||
        payload.from_number !== input.policy.allowedUserNumber
      ) {
        throw new WebhookRejection("not_allowed", 403)
      }
      return { kind: "inbound", event: normalizeInbound(payload, context) }
    }

    if (
      payload.from_number !== input.policy.fromNumber ||
      payload.to_number !== input.policy.allowedUserNumber
    ) {
      throw new WebhookRejection("unknown_line", 403)
    }
    return {
      kind: "status",
      event: normalizeStatus(payload, { ...context, ...input.statusMetadata })
    }
  } catch (error) {
    if (error instanceof WebhookRejection) throw error
    if (error instanceof WebhookValidationError || error instanceof Error) {
      throw new WebhookRejection("invalid_webhook", 400)
    }
    throw error
  }
}
