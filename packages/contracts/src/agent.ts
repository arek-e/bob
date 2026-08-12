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

export const CurrentTurnMessage = Schema.Struct({
  sourceMessageId: Uuid,
  text: NonEmptyText
})

export const AgentRunRequest = Schema.Struct({
  protocolVersion: Schema.Literal(1),
  runId: Uuid,
  ownerId: Uuid,
  correlationId: Uuid,
  conversationTurnId: Schema.optionalKey(Uuid),
  conversationTurnRevision: Schema.optionalKey(
    Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1))
  ),
  sourceMessageId: Schema.optionalKey(Uuid),
  localTime: IsoDateTime,
  timeZone: TimeZone,
  locale: Schema.optionalKey(Locale),
  hourCycle: Schema.optionalKey(HourCycle),
  userText: NonEmptyText,
  currentTurnMessages: Schema.optionalKey(
    Schema.Array(CurrentTurnMessage).check(Schema.isMaxLength(12))
  ),
  contextItems: Schema.Array(ContextItem),
  allowedTools: Schema.Array(ToolName),
  limits: Schema.Struct({
    maxTurns: Schema.Int,
    maxToolCalls: Schema.Int,
    maxDurationMs: Schema.Int,
    maxResponseCharacters: Schema.Int
  })
}).check(
  Schema.makeFilter((request) => {
    const hasTurnId = request.conversationTurnId !== undefined
    const hasTurnRevision = request.conversationTurnRevision !== undefined
    if (hasTurnId !== hasTurnRevision) {
      return {
        path: ["conversationTurnId"],
        issue: "conversationTurnId and conversationTurnRevision must be paired"
      }
    }
    const messages = request.currentTurnMessages
    if (messages === undefined) return undefined
    if (messages.length === 0) {
      return { path: ["currentTurnMessages"], issue: "current turn messages cannot be empty" }
    }
    if (messages.reduce((count, message) => count + message.text.length, 0) > 8_000) {
      return {
        path: ["currentTurnMessages"],
        issue: "current turn messages exceed the character limit"
      }
    }
    const target = messages.at(-1)
    if (target?.text !== request.userText) {
      return { path: ["currentTurnMessages"], issue: "final message must match userText" }
    }
    return target.sourceMessageId === request.sourceMessageId
      ? undefined
      : { path: ["currentTurnMessages"], issue: "final message must match sourceMessageId" }
  })
)

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

export const AgentSteerRequest = Schema.Struct({
  runId: Uuid
})

export const AgentSteerResult = Schema.Struct({
  status: Schema.Literals(["aborted_model", "queued", "missing"])
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
export type CurrentTurnMessage = typeof CurrentTurnMessage.Type
export type AgentRunRequest = typeof AgentRunRequest.Type
export type AgentRunResult = typeof AgentRunResult.Type
export type AgentSteerRequest = typeof AgentSteerRequest.Type
export type AgentSteerResult = typeof AgentSteerResult.Type
export type DeviceLoginEvent = typeof DeviceLoginEvent.Type
