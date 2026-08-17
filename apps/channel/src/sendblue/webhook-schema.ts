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
