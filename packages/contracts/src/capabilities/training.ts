import { Schema } from "effect"

import type {
  CapabilityModule,
  ToolDefinition,
  ToolDefinitionName,
  ToolInputSchema
} from "./definitions.ts"

import { idInputSchema } from "./definitions.ts"

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

export const trainingToolDefinitions = {
  gym_list: {
    name: "gym_list",
    description:
      "List the owner's gyms and stable IDs. Use this before another tool needs a gym ID.",
    inputSchema: lookup
  },
  gym_create: {
    name: "gym_create",
    description: "Save one gym after owner instruction.",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
      additionalProperties: false
    }
  },
  equipment_list: {
    name: "equipment_list",
    description:
      "List the owner's gym equipment and stable IDs. Use this before another tool needs an equipment ID.",
    inputSchema: lookup
  },
  exercise_create: {
    name: "exercise_create",
    description: "Propose one exercise for owner review.",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string" }, instructions: { type: "string" } },
      required: ["name"],
      additionalProperties: false
    }
  },
  exercise_list: {
    name: "exercise_list",
    description:
      "List the owner's exercises and stable IDs. Use this before another tool needs an exercise ID.",
    inputSchema: lookup
  },
  gym_add_equipment: {
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
  equipment_map_exercise: {
    name: "equipment_map_exercise",
    description: "Propose one equipment-to-exercise mapping for owner review.",
    inputSchema: {
      type: "object",
      properties: { equipmentId: { type: "string" }, exerciseId: { type: "string" } },
      required: ["equipmentId", "exerciseId"],
      additionalProperties: false
    }
  },
  routine_save: {
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
  routine_get: {
    name: "routine_get",
    description: "Get one owner routine and its ordered exercises.",
    inputSchema: optionalRoutine
  },
  workout_start: {
    name: "workout_start",
    description: "Start one workout session.",
    inputSchema: {
      type: "object",
      properties: { routineId: { type: "string" }, gymId: { type: "string" } },
      required: ["routineId"],
      additionalProperties: false
    }
  },
  workout_log_set: {
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
  workout_finish: {
    name: "workout_finish",
    description: "Finish one workout.",
    inputSchema: idInputSchema
  },
  workout_last: {
    name: "workout_last",
    description: "Get the owner's latest workout and its logged sets.",
    inputSchema: history
  },
  workout_history: {
    name: "workout_history",
    description: "List prior workouts.",
    inputSchema: history
  }
} as const satisfies Readonly<Partial<Record<ToolDefinitionName, ToolDefinition>>>

export const trainingCapability = {
  id: "training",
  version: 1,
  feature: "training",
  names: [
    "gym_list",
    "gym_create",
    "equipment_list",
    "exercise_create",
    "exercise_list",
    "gym_add_equipment",
    "equipment_map_exercise",
    "routine_save",
    "routine_get",
    "workout_start",
    "workout_log_set",
    "workout_finish",
    "workout_last",
    "workout_history"
  ],
  modelTools: [
    "gym_list",
    "gym_create",
    "equipment_list",
    "exercise_create",
    "exercise_list",
    "gym_add_equipment",
    "equipment_map_exercise",
    "routine_save",
    "routine_get",
    "workout_start",
    "workout_log_set",
    "workout_finish",
    "workout_last",
    "workout_history"
  ],
  definitions: trainingToolDefinitions,
  readOnly: [
    "gym_list",
    "equipment_list",
    "exercise_list",
    "routine_get",
    "workout_last",
    "workout_history"
  ],
  sourceBound: [],
  externalOutcomeUnknown: [],
  confirmedActionCodes: {},
  mutationArgumentExclusions: {},
  sourceMessageArguments: {}
} as const satisfies CapabilityModule
