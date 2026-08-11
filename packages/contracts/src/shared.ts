import { Schema } from "effect"

export const Uuid = Schema.String.check(Schema.isUUID())
export const IsoDateTime = Schema.String.check(
  Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/)
)
export const E164 = Schema.String.check(Schema.isPattern(/^\+[1-9]\d{7,14}$/))
export const NonEmptyText = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(8_000))
export const ShortText = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1_200))
export const TimeZone = Schema.String.check(Schema.isPattern(/^[A-Za-z_]+(?:\/[A-Za-z0-9_+\-]+)+$/))
export const JsonObject = Schema.Record(Schema.String, Schema.Json)

export type Uuid = typeof Uuid.Type
export type IsoDateTime = typeof IsoDateTime.Type
export type E164 = typeof E164.Type

export function decodeUnknown<S extends Schema.ConstraintDecoder<unknown>>(
  schema: S,
  input: unknown
): S["Type"] {
  return Schema.decodeUnknownSync(schema)(input) as S["Type"]
}
