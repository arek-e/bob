import { Schema } from "effect"

import { IsoDateTime, JsonObject, NonEmptyText, ShortText, TimeZone, Uuid } from "./shared.ts"

export const JournalHandoff = Schema.Struct({
  id: Uuid,
  expiresAt: IsoDateTime,
  path: Schema.String,
  bearerToken: Schema.Literal(false)
})

export const JournalEntryCreate = Schema.Struct({
  handoffId: Uuid,
  text: NonEmptyText,
  tags: Schema.Array(ShortText).check(Schema.isMaxLength(25)),
  approvedSummary: Schema.optionalKey(ShortText)
})

export const JournalEntryUpdate = Schema.Struct({
  text: NonEmptyText,
  tags: Schema.Array(ShortText).check(Schema.isMaxLength(25)),
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
  timeZone: TimeZone,
  state: Schema.Literals(["active", "paused"]),
  actionTargets: Schema.Array(
    Schema.Struct({
      occurrenceId: Uuid,
      dueAt: IsoDateTime,
      localDisplayTime: Schema.String,
      state: Schema.Literals([
        "scheduled",
        "claimed",
        "awaiting_delivery",
        "awaiting_response",
        "acknowledged"
      ])
    })
  )
})

export const ReminderList = Schema.Struct({
  reminders: Schema.Array(ReminderSummary)
})

export const ReminderSnoozeRequest = Schema.Struct({ dueAt: IsoDateTime })

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
    "outbound_exhausted",
    "delivery_result_exhausted",
    "agent_authentication_failed",
    "reminder_missed",
    "agent_quota_exhausted",
    "agent_run_failed",
    "token_budget_exceeded"
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
  sourceLabel: NonEmptyText,
  sensitivity: Schema.Literals(["normal", "private", "high"]),
  status: Schema.Literals(["proposed", "disputed"]),
  createdAt: IsoDateTime
})

export const MemoryCandidateList = Schema.Struct({
  candidates: Schema.Array(MemoryCandidateReview)
})

export const MemoryCandidateCorrection = Schema.Struct({ canonicalText: NonEmptyText })

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

const TrainingRoutineStep = Schema.Struct({
  id: Uuid,
  exerciseId: Uuid,
  exerciseName: NonEmptyText,
  position: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
  targetSets: Schema.NullOr(Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0))),
  targetReps: Schema.NullOr(Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0))),
  notes: Schema.NullOr(Schema.String)
})

export const TrainingRoutine = Schema.Struct({
  id: Uuid,
  name: NonEmptyText,
  revision: Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0)),
  steps: Schema.Array(TrainingRoutineStep)
})

const TrainingWorkoutSet = Schema.Struct({
  id: Uuid,
  routineStepId: Uuid,
  equipmentId: Schema.NullOr(Uuid),
  sequence: Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0)),
  repetitions: Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0)),
  weightGrams: Schema.NullOr(Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0))),
  notes: Schema.NullOr(Schema.String),
  loggedAt: IsoDateTime
})

const WorkoutStatus = Schema.Literals(["active", "completed", "stopped_for_safety", "abandoned"])

export const TrainingWorkout = Schema.Struct({
  id: Uuid,
  routineId: Uuid,
  routineName: NonEmptyText,
  gymId: Schema.NullOr(Uuid),
  status: WorkoutStatus,
  startedAt: IsoDateTime,
  finishedAt: Schema.NullOr(IsoDateTime),
  sets: Schema.Array(TrainingWorkoutSet)
})

export const TrainingOverview = Schema.Struct({
  gyms: Schema.Array(
    Schema.Struct({
      id: Uuid,
      name: NonEmptyText,
      equipment: Schema.Array(
        Schema.Struct({
          id: Uuid,
          name: NonEmptyText,
          identifier: Schema.NullOr(Schema.String),
          exerciseIds: Schema.Array(Uuid)
        })
      )
    })
  ),
  exercises: Schema.Array(
    Schema.Struct({
      id: Uuid,
      name: NonEmptyText,
      instructions: Schema.NullOr(Schema.String)
    })
  ),
  routines: Schema.Array(TrainingRoutine),
  activeWorkout: Schema.optionalKey(TrainingWorkout),
  history: Schema.Array(
    Schema.Struct({
      id: Uuid,
      routineId: Uuid,
      routineName: NonEmptyText,
      gymId: Schema.NullOr(Uuid),
      gymName: Schema.NullOr(Schema.String),
      status: WorkoutStatus,
      startedAt: IsoDateTime,
      finishedAt: Schema.NullOr(IsoDateTime)
    })
  )
})

export type JournalHandoff = typeof JournalHandoff.Type
export type JournalEntryCreate = typeof JournalEntryCreate.Type
export type JournalEntryUpdate = typeof JournalEntryUpdate.Type
export type JournalMetadata = typeof JournalMetadata.Type
export type JournalEntry = typeof JournalEntry.Type
export type JournalList = typeof JournalList.Type
export type ReminderSummary = typeof ReminderSummary.Type
export type ReminderList = typeof ReminderList.Type
export type ReminderSnoozeRequest = typeof ReminderSnoozeRequest.Type
export type AdminStatus = typeof AdminStatus.Type
export type OperationalAlert = typeof OperationalAlert.Type
export type AlertList = typeof AlertList.Type
export type MemoryCandidateReview = typeof MemoryCandidateReview.Type
export type MemoryCandidateList = typeof MemoryCandidateList.Type
export type MemoryCandidateCorrection = typeof MemoryCandidateCorrection.Type
export type TrainingProposalReview = typeof TrainingProposalReview.Type
export type TrainingProposalList = typeof TrainingProposalList.Type
export type TrainingProposalApproval = typeof TrainingProposalApproval.Type
export type TrainingRoutine = typeof TrainingRoutine.Type
export type TrainingWorkout = typeof TrainingWorkout.Type
export type TrainingOverview = typeof TrainingOverview.Type
