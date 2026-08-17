import { IsoDateTime, NonEmptyText, ShortText } from "@bob/shared-types/shared"
import { Schema } from "effect"

export const ContextSource = Schema.Struct({
  sourceId: NonEmptyText,
  sourceLabel: ShortText,
  occurredAt: Schema.optionalKey(IsoDateTime)
})

export const ContextItem = Schema.Struct({
  kind: Schema.String.check(
    Schema.isPattern(/^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/),
    Schema.isMaxLength(64)
  ),
  text: ShortText,
  instruction: Schema.Literal(false),
  conflict: Schema.Boolean,
  sources: Schema.Array(ContextSource)
})

export type ContextSource = typeof ContextSource.Type
export type ContextItem = typeof ContextItem.Type
