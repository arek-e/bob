import type { CapabilityModule, ToolInputSchema } from "@bob/capabilities-types/definitions"

import { idInputSchema } from "@bob/capabilities-types/definitions"
import { Schema } from "effect"

export const TrainingLookupArguments = Schema.Struct({
  query: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(100)))
})
export const GymCreateArguments = Schema.Struct({ name: Schema.String })
export const ExerciseCreateArguments = Schema.Struct({
  name: Schema.String,
  instructions: Schema.optionalKey(Schema.String)
})
export const GymAddEquipmentArguments = Schema.Struct({
  gymId: Schema.String,
  name: Schema.String,
  identifier: Schema.optionalKey(Schema.String)
})
export const EquipmentMapExerciseArguments = Schema.Struct({
  equipmentId: Schema.String,
  exerciseId: Schema.String
})
export const RoutineSaveArguments = Schema.Struct({
  name: Schema.String,
  steps: Schema.Array(
    Schema.Struct({
      exerciseId: Schema.String,
      targetSets: Schema.optionalKey(Schema.Int),
      targetReps: Schema.optionalKey(Schema.Int),
      notes: Schema.optionalKey(Schema.String)
    })
  )
})
export const RoutineGetArguments = Schema.Struct({ id: Schema.optionalKey(Schema.String) })
export const WorkoutStartArguments = Schema.Struct({
  routineId: Schema.String,
  gymId: Schema.optionalKey(Schema.String)
})
export const WorkoutLogSetArguments = Schema.Struct({
  sessionId: Schema.String,
  routineStepId: Schema.String,
  equipmentId: Schema.optionalKey(Schema.String),
  sequence: Schema.Int,
  repetitions: Schema.Int,
  weightGrams: Schema.optionalKey(Schema.Int),
  notes: Schema.optionalKey(Schema.String)
})
export const WorkoutFinishArguments = Schema.Struct({ id: Schema.String })
export const WorkoutHistoryArguments = Schema.Struct({
  routineId: Schema.optionalKey(Schema.String)
})
export type TrainingLookupArguments = typeof TrainingLookupArguments.Type
export type GymCreateArguments = typeof GymCreateArguments.Type
export type ExerciseCreateArguments = typeof ExerciseCreateArguments.Type
export type GymAddEquipmentArguments = typeof GymAddEquipmentArguments.Type
export type EquipmentMapExerciseArguments = typeof EquipmentMapExerciseArguments.Type
export type RoutineSaveArguments = typeof RoutineSaveArguments.Type
export type RoutineGetArguments = typeof RoutineGetArguments.Type
export type WorkoutStartArguments = typeof WorkoutStartArguments.Type
export type WorkoutLogSetArguments = typeof WorkoutLogSetArguments.Type
export type WorkoutFinishArguments = typeof WorkoutFinishArguments.Type
export type WorkoutHistoryArguments = typeof WorkoutHistoryArguments.Type

const lookup = {
  type: "object",
  properties: { query: { type: "string", maxLength: 100 } },
  additionalProperties: false
} as const satisfies ToolInputSchema
const optionalRoutine = {
  type: "object",
  properties: { id: { type: "string" } },
  additionalProperties: false
} as const satisfies ToolInputSchema
const history = {
  type: "object",
  properties: { routineId: { type: "string" } },
  additionalProperties: false
} as const satisfies ToolInputSchema

export const trainingCapability = {
  id: "training",
  version: 1,
  feature: "training",
  tools: [
    {
      kind: "model",
      name: "gym_list",
      description:
        "List the owner's gyms and stable IDs. Use this before another tool needs a gym ID.",
      inputSchema: lookup,
      readOnly: true
    },
    {
      kind: "model",
      name: "gym_create",
      description: "Save one gym after owner instruction.",
      inputSchema: {
        type: "object",
        properties: { name: { type: "string" } },
        required: ["name"],
        additionalProperties: false
      }
    },
    {
      kind: "model",
      name: "equipment_list",
      description:
        "List the owner's gym equipment and stable IDs. Use this before another tool needs an equipment ID.",
      inputSchema: lookup,
      readOnly: true
    },
    {
      kind: "model",
      name: "exercise_create",
      description: "Propose one exercise for owner review.",
      inputSchema: {
        type: "object",
        properties: { name: { type: "string" }, instructions: { type: "string" } },
        required: ["name"],
        additionalProperties: false
      }
    },
    {
      kind: "model",
      name: "exercise_list",
      description:
        "List the owner's exercises and stable IDs. Use this before another tool needs an exercise ID.",
      inputSchema: lookup,
      readOnly: true
    },
    {
      kind: "model",
      name: "gym_add_equipment",
      description: "Save equipment for a gym.",
      inputSchema: {
        type: "object",
        properties: {
          gymId: { type: "string" },
          name: { type: "string" },
          identifier: { type: "string" }
        },
        required: ["gymId", "name"],
        additionalProperties: false
      }
    },
    {
      kind: "model",
      name: "equipment_map_exercise",
      description: "Propose one equipment-to-exercise mapping for owner review.",
      inputSchema: {
        type: "object",
        properties: { equipmentId: { type: "string" }, exerciseId: { type: "string" } },
        required: ["equipmentId", "exerciseId"],
        additionalProperties: false
      }
    },
    {
      kind: "model",
      name: "routine_save",
      description: "Save an owner-approved training routine.",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string" },
          steps: {
            type: "array",
            items: {
              type: "object",
              properties: {
                exerciseId: { type: "string" },
                targetSets: { type: "integer" },
                targetReps: { type: "integer" },
                notes: { type: "string" }
              },
              required: ["exerciseId"],
              additionalProperties: false
            }
          }
        },
        required: ["name", "steps"],
        additionalProperties: false
      }
    },
    {
      kind: "model",
      name: "routine_get",
      description: "Get one owner routine and its ordered exercises.",
      inputSchema: optionalRoutine,
      readOnly: true
    },
    {
      kind: "model",
      name: "workout_start",
      description: "Start one workout session.",
      inputSchema: {
        type: "object",
        properties: { routineId: { type: "string" }, gymId: { type: "string" } },
        required: ["routineId"],
        additionalProperties: false
      }
    },
    {
      kind: "model",
      name: "workout_log_set",
      description: "Log one set. Safety reports are handled before model execution.",
      inputSchema: {
        type: "object",
        properties: {
          sessionId: { type: "string" },
          routineStepId: { type: "string" },
          equipmentId: { type: "string" },
          sequence: { type: "integer" },
          repetitions: { type: "integer" },
          weightGrams: { type: "integer" },
          notes: { type: "string" }
        },
        required: ["sessionId", "routineStepId", "sequence", "repetitions"],
        additionalProperties: false
      }
    },
    {
      kind: "model",
      name: "workout_finish",
      description: "Finish one workout.",
      inputSchema: idInputSchema
    },
    {
      kind: "model",
      name: "workout_last",
      description: "Get the owner's latest workout and its logged sets.",
      inputSchema: history,
      readOnly: true
    },
    {
      kind: "model",
      name: "workout_history",
      description: "List prior workouts.",
      inputSchema: history,
      readOnly: true
    }
  ]
} as const satisfies CapabilityModule
