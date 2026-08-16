import { IsoDateTime, JsonObject, NonEmptyText, Uuid } from "@bob/core-capabilities-types/shared"
import { Schema } from "effect"

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

export type TrainingProposalReview = typeof TrainingProposalReview.Type
export type TrainingProposalList = typeof TrainingProposalList.Type
export type TrainingProposalApproval = typeof TrainingProposalApproval.Type
export type TrainingRoutine = typeof TrainingRoutine.Type
export type TrainingWorkout = typeof TrainingWorkout.Type
export type TrainingOverview = typeof TrainingOverview.Type
