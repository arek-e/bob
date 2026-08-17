import { AgentArtifact } from "@bob/artifacts-types/artifact"
import { ContextItem, ContextSource } from "@bob/context-types/item"
import { HourCycle } from "@bob/settings-types/settings"
import {
  IsoDateTime,
  Locale,
  NonEmptyText,
  ShortText,
  TimeZone,
  Uuid
} from "@bob/shared-types/shared"
import { DeploymentProfileId } from "@bob/tools-types/catalogue"
import { PriorToolReceipt } from "@bob/tools-types/receipts"
import { CapabilityCatalogueGeneration, ToolName } from "@bob/tools-types/tools"
import { Schema } from "effect"

export { AgentArtifact, PlanArtifact } from "@bob/artifacts-types/artifact"
export { ContextItem, ContextSource } from "@bob/context-types/item"

export const CurrentTurnMessage = Schema.Struct({
  sourceMessageId: Uuid,
  text: NonEmptyText
})

export { PriorToolReceipt, PriorToolReceiptOrigin } from "@bob/tools-types/receipts"

export const AgentRunRequest = Schema.Struct({
  protocolVersion: Schema.Literal(1),
  legacySnapshotReplay: Schema.optionalKey(Schema.Literal(true)),
  deploymentProfileId: Schema.optionalKey(DeploymentProfileId),
  capabilityCatalogueGeneration: Schema.optionalKey(CapabilityCatalogueGeneration),
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
  priorToolReceipts: Schema.optionalKey(
    Schema.Array(PriorToolReceipt).check(Schema.isMaxLength(8))
  ),
  grounding: Schema.optionalKey(Schema.Struct({ requiresSources: Schema.Boolean })),
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
  artifact: Schema.optionalKey(AgentArtifact),
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

const AgentRunOperationSequence = Schema.Number.check(
  Schema.isInt(),
  Schema.isBetween({ minimum: 1, maximum: 32 })
)

export const AgentRunOperation = Schema.Struct({
  protocolVersion: Schema.Literal(1),
  loopVersion: Schema.Literal(1),
  runId: Uuid,
  sequence: AgentRunOperationSequence,
  kind: Schema.Literals(["model", "tool", "final"]),
  payload: Schema.Json
})

export const AgentRunOperationAppendRequest = Schema.Struct({
  attemptId: Uuid,
  operation: AgentRunOperation
})

export const AgentRunOperationAppendResult = Schema.Struct({
  status: Schema.Literals(["appended", "duplicate"])
})

export const AgentRunOperationsLoadRequest = Schema.Struct({
  runId: Uuid,
  attemptId: Uuid
})

export const AgentRunOperationsLoadResult = Schema.Struct({
  operations: Schema.Array(AgentRunOperation).check(Schema.isMaxLength(32))
})

export const AgentSmokeResult = Schema.Struct({
  protocolVersion: Schema.Literal(1),
  status: Schema.Literals(["completed", "failed"]),
  model: NonEmptyText,
  durationMs: Schema.Int,
  errorCode: Schema.optionalKey(
    Schema.Literals([
      "authentication",
      "quota",
      "timeout",
      "cancelled",
      "provider",
      "invalid_output"
    ])
  )
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

export type CurrentTurnMessage = typeof CurrentTurnMessage.Type
export type AgentRunRequest = typeof AgentRunRequest.Type
export type AgentRunResult = typeof AgentRunResult.Type
export type AgentRunOperation = typeof AgentRunOperation.Type
export type AgentRunOperationAppendRequest = typeof AgentRunOperationAppendRequest.Type
export type AgentRunOperationAppendResult = typeof AgentRunOperationAppendResult.Type
export type AgentRunOperationsLoadRequest = typeof AgentRunOperationsLoadRequest.Type
export type AgentRunOperationsLoadResult = typeof AgentRunOperationsLoadResult.Type
export type AgentSmokeResult = typeof AgentSmokeResult.Type
export type AgentSteerRequest = typeof AgentSteerRequest.Type
export type AgentSteerResult = typeof AgentSteerResult.Type
export type DeviceLoginEvent = typeof DeviceLoginEvent.Type
