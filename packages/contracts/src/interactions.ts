import { Schema } from "effect"

import { E164, NonEmptyText } from "./shared.ts"

export const StartMessageInteraction = Schema.Struct({
  action: Schema.Literal("start"),
  number: E164,
  fromNumber: E164,
  messageHandle: NonEmptyText,
  react: Schema.Boolean,
  maxDurationMs: Schema.Number.check(
    Schema.isInt(),
    Schema.isBetween({ minimum: 1, maximum: 300_000 })
  )
})

export const StopMessageInteraction = Schema.Struct({
  action: Schema.Literal("stop"),
  number: E164,
  fromNumber: E164
})

export const MessageInteractionCommand = Schema.Union([
  StartMessageInteraction,
  StopMessageInteraction
])

export type MessageInteractionCommand = typeof MessageInteractionCommand.Type
