import { Schema } from "effect"

import { IsoDateTime, JsonObject, NonEmptyText, ShortText, Uuid } from "./shared.ts"

export const JournalHandoff = Schema.Struct({
  id: Uuid,
  expiresAt: IsoDateTime,
  path: Schema.String,
  bearerToken: Schema.Literal(false)
})

export const JournalEntryCreate = Schema.Struct({
  handoffId: Uuid,
  text: NonEmptyText,
  tags: Schema.Array(ShortText),
  approvedSummary: Schema.optionalKey(ShortText)
})

export const JournalMetadata = Schema.Struct({
  id: Uuid,
  createdAt: IsoDateTime,
  tags: Schema.Array(ShortText),
  approvedSummary: Schema.optionalKey(ShortText)
})

export const JournalEntry = Schema.Struct({
  ...JournalMetadata.fields,
  text: NonEmptyText
})

export const JournalList = Schema.Struct({
  entries: Schema.Array(JournalMetadata)
})

export const ReminderSummary = Schema.Struct({
  id: Uuid,
  displayText: NonEmptyText,
  nextDueAt: Schema.optionalKey(IsoDateTime),
  localDisplayTime: Schema.optionalKey(Schema.String),
  state: Schema.Literals(["active", "paused"])
})

export const ReminderList = Schema.Struct({
  reminders: Schema.Array(ReminderSummary)
})

export const AdminStatus = Schema.Struct({
  configured: Schema.Boolean,
  provider: Schema.String,
  expiresAt: Schema.optionalKey(IsoDateTime),
  accountIdRedacted: Schema.optionalKey(Schema.String)
})

export const OperationalAlert = Schema.Struct({
  id: Uuid,
  code: Schema.Literals([
    "inbound_exhausted",
    "delivery_uncertain",
    "delivery_result_exhausted",
    "agent_authentication_failed",
    "reminder_missed"
  ]),
  objectType: NonEmptyText,
  objectId: NonEmptyText,
  state: Schema.Literals(["open", "reconciling", "resolved"]),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime
})

export const AlertList = Schema.Struct({ alerts: Schema.Array(OperationalAlert) })

export const MemoryCandidateReview = Schema.Struct({
  id: Uuid,
  scope: NonEmptyText,
  key: NonEmptyText,
  value: Schema.Json,
  canonicalText: NonEmptyText,
  originClass: Schema.Literals([
    "owner_input",
    "system_record",
    "recalled_content",
    "tool_output",
    "assistant_output",
    "background_model"
  ]),
  sourceType: NonEmptyText,
  sourceId: NonEmptyText,
  sensitivity: Schema.Literals(["normal", "private", "high"]),
  status: Schema.Literals(["proposed", "disputed"]),
  createdAt: IsoDateTime
})

export const MemoryCandidateList = Schema.Struct({
  candidates: Schema.Array(MemoryCandidateReview)
})

export const TrainingProposalReview = Schema.Struct({
  id: Uuid,
  proposalHash: NonEmptyText,
  toolName: Schema.Literals([
    "gym_create",
    "exercise_create",
    "gym_add_equipment",
    "equipment_map_exercise",
    "routine_save",
    "workout_start",
    "workout_log_set",
    "workout_finish"
  ]),
  arguments: JsonObject,
  status: Schema.Literals(["proposed", "applying", "applied", "rejected"]),
  createdAt: IsoDateTime,
  approvedAt: Schema.optionalKey(IsoDateTime),
  appliedAt: Schema.optionalKey(IsoDateTime)
})

export const TrainingProposalList = Schema.Struct({
  proposals: Schema.Array(TrainingProposalReview)
})

export const TrainingProposalApproval = Schema.Struct({
  proposalHash: Schema.String.check(Schema.isPattern(/^sha256:[a-f0-9]{64}$/u))
})

export type JournalHandoff = typeof JournalHandoff.Type
export type JournalEntryCreate = typeof JournalEntryCreate.Type
export type JournalMetadata = typeof JournalMetadata.Type
export type JournalEntry = typeof JournalEntry.Type
export type JournalList = typeof JournalList.Type
export type ReminderSummary = typeof ReminderSummary.Type
export type ReminderList = typeof ReminderList.Type
export type AdminStatus = typeof AdminStatus.Type
export type OperationalAlert = typeof OperationalAlert.Type
export type AlertList = typeof AlertList.Type
export type MemoryCandidateReview = typeof MemoryCandidateReview.Type
export type MemoryCandidateList = typeof MemoryCandidateList.Type
export type TrainingProposalReview = typeof TrainingProposalReview.Type
export type TrainingProposalList = typeof TrainingProposalList.Type
export type TrainingProposalApproval = typeof TrainingProposalApproval.Type
