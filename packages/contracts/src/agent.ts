import { Schema } from "effect"

import { HourCycle } from "./settings.ts"
import { IsoDateTime, Locale, NonEmptyText, ShortText, TimeZone, Uuid } from "./shared.ts"
import { CapabilityCatalogueGeneration, ToolName } from "./tools.ts"

const ArtifactTitle = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(120))
const ArtifactHeading = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(80))
const ArtifactItem = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(240))

const PlanArtifactFields = {
  title: ArtifactTitle,
  durationMinutes: Schema.NullOr(
    Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: 1, maximum: 240 }))
  ),
  sections: Schema.Array(
    Schema.Struct({
      heading: ArtifactHeading,
      items: Schema.Array(ArtifactItem).check(Schema.isMinLength(1), Schema.isMaxLength(12))
    })
  ).check(Schema.isMinLength(1), Schema.isMaxLength(8))
}

export const PlanArtifact = Schema.Struct({
  kind: Schema.Literal("plan"),
  ...PlanArtifactFields
})

/** Legacy shape for artifacts saved before plans became domain-neutral. */
export const TrainingPlanArtifact = Schema.Struct({
  kind: Schema.Literal("training_plan"),
  ...PlanArtifactFields
})

export const AgentArtifact = Schema.Union([PlanArtifact, TrainingPlanArtifact])

export const ContextSource = Schema.Struct({
  sourceId: NonEmptyText,
  sourceLabel: ShortText,
  occurredAt: Schema.optionalKey(IsoDateTime)
})

export const ContextItem = Schema.Struct({
  kind: Schema.Literals([
    "profile",
    "conversation",
    "artifact",
    "reminder",
    "training",
    "fact",
    "skill"
  ]),
  text: ShortText,
  instruction: Schema.Literal(false),
  conflict: Schema.Boolean,
  sources: Schema.Array(ContextSource)
})

export const CurrentTurnMessage = Schema.Struct({
  sourceMessageId: Uuid,
  text: NonEmptyText
})

export const PriorToolReceiptOrigin = Schema.Literals(["same_turn", "predecessor_turn"])

export const PriorToolReceipt = Schema.Union([
  Schema.Struct({
    origin: PriorToolReceiptOrigin,
    toolName: Schema.Literal("reminder_create"),
    result: Schema.Struct({
      ok: Schema.Literal(true),
      code: Schema.Literals(["reminder_created", "reminder_exists"])
    })
  }),
  Schema.Struct({
    origin: PriorToolReceiptOrigin,
    toolName: Schema.Literal("reminder_acknowledge"),
    result: Schema.Struct({ ok: Schema.Literal(true), code: Schema.Literal("reminder_seen") })
  }),
  Schema.Struct({
    origin: PriorToolReceiptOrigin,
    toolName: Schema.Literal("reminder_complete"),
    result: Schema.Struct({ ok: Schema.Literal(true), code: Schema.Literal("reminder_done") })
  }),
  Schema.Struct({
    origin: PriorToolReceiptOrigin,
    toolName: Schema.Literal("reminder_snooze"),
    result: Schema.Struct({ ok: Schema.Literal(true), code: Schema.Literal("reminder_snoozed") })
  }),
  Schema.Struct({
    origin: PriorToolReceiptOrigin,
    toolName: Schema.Literal("reminder_cancel"),
    result: Schema.Struct({
      ok: Schema.Literal(true),
      code: Schema.Literals(["reminder_cancelled", "reminder_occurrence_cancelled"])
    })
  }),
  Schema.Struct({
    origin: PriorToolReceiptOrigin,
    toolName: Schema.Literal("memory_propose"),
    result: Schema.Struct({ ok: Schema.Literal(true), code: Schema.Literal("memory_proposed") })
  }),
  Schema.Struct({
    origin: PriorToolReceiptOrigin,
    toolName: Schema.Literal("journal_link_create"),
    result: Schema.Struct({
      ok: Schema.Literal(true),
      code: Schema.Literal("journal_link_created")
    })
  }),
  Schema.Struct({
    origin: PriorToolReceiptOrigin,
    toolName: Schema.Literal("connection_link_create"),
    result: Schema.Struct({
      ok: Schema.Literal(true),
      code: Schema.Literal("connection_link_created")
    })
  }),
  Schema.Struct({
    origin: PriorToolReceiptOrigin,
    toolName: Schema.Literal("settings_update"),
    result: Schema.Struct({
      ok: Schema.Literal(true),
      code: Schema.Literal("owner_settings_updated")
    })
  }),
  Schema.Struct({
    origin: PriorToolReceiptOrigin,
    toolName: ToolName,
    result: Schema.Struct({
      ok: Schema.Literal(false),
      code: Schema.Literal("tool_recovery_failed")
    })
  })
])

export const AgentRunRequest = Schema.Struct({
  protocolVersion: Schema.Literal(1),
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
export type PlanArtifact = typeof PlanArtifact.Type
export type TrainingPlanArtifact = typeof TrainingPlanArtifact.Type
export type AgentArtifact = typeof AgentArtifact.Type
export type ContextItem = typeof ContextItem.Type
export type CurrentTurnMessage = typeof CurrentTurnMessage.Type
export type PriorToolReceiptOrigin = typeof PriorToolReceiptOrigin.Type
export type PriorToolReceipt = typeof PriorToolReceipt.Type
export type AgentRunRequest = typeof AgentRunRequest.Type
export type AgentRunResult = typeof AgentRunResult.Type
export type AgentSteerRequest = typeof AgentSteerRequest.Type
export type AgentSteerResult = typeof AgentSteerResult.Type
export type DeviceLoginEvent = typeof DeviceLoginEvent.Type
