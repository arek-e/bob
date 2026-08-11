import { Schema } from "effect"

import { HourCycle } from "./settings.ts"
import { IsoDateTime, Locale, NonEmptyText, ShortText, TimeZone, Uuid } from "./shared.ts"
import { ToolName } from "./tools.ts"

export const ContextSource = Schema.Struct({
  sourceId: NonEmptyText,
  sourceLabel: ShortText,
  occurredAt: Schema.optionalKey(IsoDateTime)
})

export const ContextItem = Schema.Struct({
  kind: Schema.Literals(["profile", "conversation", "reminder", "training", "fact", "skill"]),
  text: ShortText,
  instruction: Schema.Literal(false),
  conflict: Schema.Boolean,
  sources: Schema.Array(ContextSource)
})

export const AgentRunRequest = Schema.Struct({
  protocolVersion: Schema.Literal(1),
  runId: Uuid,
  ownerId: Uuid,
  correlationId: Uuid,
  sourceMessageId: Schema.optionalKey(Uuid),
  localTime: IsoDateTime,
  timeZone: TimeZone,
  locale: Schema.optionalKey(Locale),
  hourCycle: Schema.optionalKey(HourCycle),
  userText: NonEmptyText,
  contextItems: Schema.Array(ContextItem),
  allowedTools: Schema.Array(ToolName),
  limits: Schema.Struct({
    maxTurns: Schema.Int,
    maxToolCalls: Schema.Int,
    maxDurationMs: Schema.Int,
    maxResponseCharacters: Schema.Int
  })
})

export const AgentRunResult = Schema.Struct({
  protocolVersion: Schema.Literal(1),
  runId: Uuid,
  correlationId: Uuid,
  status: Schema.Literals(["completed", "failed", "cancelled"]),
  responseText: Schema.optionalKey(ShortText),
  sourceIds: Schema.optionalKey(Schema.Array(NonEmptyText).check(Schema.isMaxLength(24))),
  trustedToolSources: Schema.optionalKey(Schema.Array(ContextSource).check(Schema.isMaxLength(24))),
  conflict: Schema.optionalKey(Schema.Literals(["none", "disclosed"])),
  errorCode: Schema.optionalKey(
    Schema.Literals([
      "authentication",
      "quota",
      "timeout",
      "cancelled",
      "provider",
      "policy",
      "invalid_output"
    ])
  ),
  model: NonEmptyText,
  durationMs: Schema.Int,
  inputTokens: Schema.Int,
  outputTokens: Schema.Int,
  toolCalls: Schema.Int
})

export const DeviceLoginEvent = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("device_code"),
    verificationUri: Schema.String,
    userCode: Schema.String,
    expiresAt: IsoDateTime
  }),
  Schema.Struct({
    type: Schema.Literal("completed"),
    accountIdRedacted: Schema.String,
    expiresAt: IsoDateTime
  }),
  Schema.Struct({
    type: Schema.Literal("failed"),
    code: Schema.String
  })
])

export type ContextSource = typeof ContextSource.Type
export type ContextItem = typeof ContextItem.Type
export type AgentRunRequest = typeof AgentRunRequest.Type
export type AgentRunResult = typeof AgentRunResult.Type
export type DeviceLoginEvent = typeof DeviceLoginEvent.Type
