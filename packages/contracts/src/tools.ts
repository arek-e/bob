import { Schema } from "effect"

import { IsoDateTime, JsonObject, NonEmptyText, ShortText, TimeZone, Uuid } from "./shared.ts"

export const ToolName = Schema.Literals([
  "reminder_create",
  "reminder_list",
  "reminder_acknowledge",
  "reminder_complete",
  "reminder_snooze",
  "reminder_cancel",
  "memory_search",
  "memory_propose",
  "memory_confirm",
  "memory_correct",
  "journal_link_create",
  "journal_search_metadata",
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
  "workout_history",
  "settings_get",
  "settings_update",
  "connection_list",
  "connection_link_create"
])

/**
 * A JSON Schema subset that describes one model input without naming a model
 * provider. Bob's Pi Module translates this shape into Pi's TypeBox value.
 */
export interface ToolInputSchema {
  readonly type: "object"
  readonly properties: Readonly<Record<string, ToolInputPropertySchema>>
  readonly required?: readonly string[]
  readonly additionalProperties?: boolean
}

export interface ToolInputPropertySchema {
  readonly type?: "object" | "array" | "string" | "number" | "integer" | "boolean" | "null"
  readonly properties?: Readonly<Record<string, ToolInputPropertySchema>>
  readonly required?: readonly string[]
  readonly additionalProperties?: boolean
  readonly items?: ToolInputPropertySchema
  readonly enum?: readonly (string | number | boolean | null)[]
  readonly anyOf?: readonly ToolInputPropertySchema[]
  readonly minLength?: number
  readonly maxLength?: number
  readonly minimum?: number
  readonly maximum?: number
  readonly pattern?: string
  readonly description?: string
}

export const ConnectionProviderArguments = Schema.Struct({
  provider: Schema.Literals(["google_calendar", "microsoft_calendar"])
})

export const ReminderCreateArguments = Schema.Struct({
  displayText: ShortText,
  smsSafeText: ShortText,
  localDate: Schema.String,
  localTime: Schema.String,
  timeZone: TimeZone,
  dueAt: IsoDateTime,
  sourceMessageId: Uuid,
  requiresAcknowledgment: Schema.Boolean
})

export const ReminderOccurrenceArguments = Schema.Struct({
  occurrenceId: Uuid
})

export const ReminderSnoozeArguments = Schema.Struct({
  occurrenceId: Uuid,
  localDate: Schema.String,
  localTime: Schema.String,
  timeZone: TimeZone,
  dueAt: IsoDateTime
})

export const ReminderCancelArguments = Schema.Struct({
  reminderId: Uuid,
  occurrenceId: Schema.optionalKey(Uuid)
})

export const MemorySearchArguments = Schema.Struct({
  query: Schema.String
})

export const MemoryProposeArguments = Schema.Struct({
  scope: Schema.String,
  key: Schema.String,
  value: Schema.Json,
  canonicalText: Schema.String,
  assertionKind: Schema.Literals(["user_stated", "system_recorded", "inferred"]),
  extractionConfidence: Schema.Number,
  importance: Schema.Number,
  explicitRemember: Schema.Boolean
})

export const MemoryConfirmArguments = Schema.Struct({
  id: Schema.String
})

export const JournalSearchMetadataArguments = Schema.Struct({
  tag: Schema.optionalKey(Schema.String)
})

export const TrainingLookupArguments = Schema.Struct({
  query: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(100)))
})

export const GymCreateArguments = Schema.Struct({
  name: Schema.String
})

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

export const RoutineGetArguments = Schema.Struct({
  id: Schema.optionalKey(Schema.String)
})

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

export const WorkoutFinishArguments = Schema.Struct({
  id: Schema.String
})

export const WorkoutHistoryArguments = Schema.Struct({
  routineId: Schema.optionalKey(Schema.String)
})

export const SettingsUpdateArguments = Schema.Struct({
  timeZone: Schema.optionalKey(TimeZone),
  locale: Schema.optionalKey(Schema.String),
  hourCycle: Schema.optionalKey(Schema.Literals(["auto", "h12", "h23"]))
})

/**
 * Tool names that Pi may expose to the model. `memory_correct` is a
 * deterministic bound command and is intentionally not a model tool.
 */
export type ToolDefinitionName = Exclude<ToolName, "memory_correct">

export interface ToolDefinition<Name extends ToolDefinitionName = ToolDefinitionName> {
  readonly name: Name
  readonly description: string
  readonly inputSchema: ToolInputSchema
}

const emptyInputSchema = {
  type: "object",
  properties: {},
  additionalProperties: false
} as const satisfies ToolInputSchema

const idInputSchema = {
  type: "object",
  properties: {
    id: { type: "string" }
  },
  required: ["id"],
  additionalProperties: false
} as const satisfies ToolInputSchema

const occurrenceInputSchema = {
  type: "object",
  properties: {
    occurrenceId: { type: "string" }
  },
  required: ["occurrenceId"],
  additionalProperties: false
} as const satisfies ToolInputSchema

const trainingLookupInputSchema = {
  type: "object",
  properties: {
    query: { type: "string", maxLength: 100 }
  },
  additionalProperties: false
} as const satisfies ToolInputSchema

const optionalRoutineInputSchema = {
  type: "object",
  properties: {
    id: { type: "string" }
  },
  additionalProperties: false
} as const satisfies ToolInputSchema

const workoutHistoryInputSchema = {
  type: "object",
  properties: {
    routineId: { type: "string" }
  },
  additionalProperties: false
} as const satisfies ToolInputSchema

const toolDefinitions = {
  reminder_create: {
    name: "reminder_create",
    description: "Create one confirmed reminder with an absolute local date and time.",
    inputSchema: {
      type: "object",
      properties: {
        displayText: { type: "string", minLength: 1, maxLength: 1_200 },
        smsSafeText: { type: "string", minLength: 1, maxLength: 1_200 },
        localDate: { type: "string" },
        localTime: { type: "string" },
        timeZone: { type: "string" },
        dueAt: { type: "string" },
        sourceMessageId: { type: "string" },
        requiresAcknowledgment: { type: "boolean" }
      },
      required: [
        "displayText",
        "smsSafeText",
        "localDate",
        "localTime",
        "timeZone",
        "dueAt",
        "sourceMessageId",
        "requiresAcknowledgment"
      ],
      additionalProperties: false
    } as const
  },
  reminder_list: {
    name: "reminder_list",
    description: "List active reminders and their exact action target IDs.",
    inputSchema: emptyInputSchema
  },
  reminder_acknowledge: {
    name: "reminder_acknowledge",
    description: "Mark one listed reminder occurrence as seen.",
    inputSchema: occurrenceInputSchema
  },
  reminder_complete: {
    name: "reminder_complete",
    description: "Mark one listed reminder occurrence as done.",
    inputSchema: occurrenceInputSchema
  },
  reminder_snooze: {
    name: "reminder_snooze",
    description:
      "Snooze one listed occurrence to an absolute local date and time in the owner's current time zone.",
    inputSchema: {
      type: "object",
      properties: {
        occurrenceId: { type: "string" },
        localDate: { type: "string" },
        localTime: { type: "string" },
        timeZone: { type: "string" },
        dueAt: { type: "string" }
      },
      required: ["occurrenceId", "localDate", "localTime", "timeZone", "dueAt"],
      additionalProperties: false
    } as const
  },
  reminder_cancel: {
    name: "reminder_cancel",
    description:
      "Cancel one listed occurrence when occurrenceId is present. Otherwise, cancel the complete reminder series.",
    inputSchema: {
      type: "object",
      properties: {
        reminderId: { type: "string" },
        occurrenceId: { type: "string" }
      },
      required: ["reminderId"],
      additionalProperties: false
    } as const
  },
  memory_search: {
    name: "memory_search",
    description: "Find policy-cleared personal records with source labels.",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
      additionalProperties: false
    } as const
  },
  memory_propose: {
    name: "memory_propose",
    description:
      "Save a reviewable personal memory candidate from the owner's direct wording. This does not confirm it.",
    inputSchema: {
      type: "object",
      properties: {
        scope: { type: "string" },
        key: { type: "string" },
        value: {},
        canonicalText: { type: "string" },
        assertionKind: {
          type: "string",
          enum: ["user_stated", "system_recorded", "inferred"]
        },
        extractionConfidence: { type: "number" },
        importance: { type: "number" },
        explicitRemember: { type: "boolean" }
      },
      required: [
        "scope",
        "key",
        "value",
        "canonicalText",
        "assertionKind",
        "extractionConfidence",
        "importance",
        "explicitRemember"
      ],
      additionalProperties: false
    } as const
  },
  memory_confirm: {
    name: "memory_confirm",
    description: "Confirm one owner-approved memory candidate.",
    inputSchema: idInputSchema
  },
  journal_link_create: {
    name: "journal_link_create",
    description: "Create a private short-lived journal link. Never accept journal text.",
    inputSchema: emptyInputSchema
  },
  journal_search_metadata: {
    name: "journal_search_metadata",
    description: "Find journal dates and tags. Journal text and summaries stay private.",
    inputSchema: {
      type: "object",
      properties: { tag: { type: "string" } },
      additionalProperties: false
    } as const
  },
  gym_list: {
    name: "gym_list",
    description:
      "List the owner's gyms and stable IDs. Use this before another tool needs a gym ID.",
    inputSchema: trainingLookupInputSchema
  },
  gym_create: {
    name: "gym_create",
    description: "Save one gym after owner instruction.",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
      additionalProperties: false
    } as const
  },
  equipment_list: {
    name: "equipment_list",
    description:
      "List the owner's gym equipment and stable IDs. Use this before another tool needs an equipment ID.",
    inputSchema: trainingLookupInputSchema
  },
  exercise_create: {
    name: "exercise_create",
    description: "Propose one exercise for owner review.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        instructions: { type: "string" }
      },
      required: ["name"],
      additionalProperties: false
    } as const
  },
  exercise_list: {
    name: "exercise_list",
    description:
      "List the owner's exercises and stable IDs. Use this before another tool needs an exercise ID.",
    inputSchema: trainingLookupInputSchema
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
    } as const
  },
  equipment_map_exercise: {
    name: "equipment_map_exercise",
    description: "Propose one equipment-to-exercise mapping for owner review.",
    inputSchema: {
      type: "object",
      properties: {
        equipmentId: { type: "string" },
        exerciseId: { type: "string" }
      },
      required: ["equipmentId", "exerciseId"],
      additionalProperties: false
    } as const
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
    } as const
  },
  routine_get: {
    name: "routine_get",
    description: "Get one owner routine and its ordered exercises.",
    inputSchema: optionalRoutineInputSchema
  },
  workout_start: {
    name: "workout_start",
    description: "Start one workout session.",
    inputSchema: {
      type: "object",
      properties: {
        routineId: { type: "string" },
        gymId: { type: "string" }
      },
      required: ["routineId"],
      additionalProperties: false
    } as const
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
    } as const
  },
  workout_finish: {
    name: "workout_finish",
    description: "Finish one workout.",
    inputSchema: idInputSchema
  },
  workout_last: {
    name: "workout_last",
    description: "Get the owner's latest workout and its logged sets.",
    inputSchema: workoutHistoryInputSchema
  },
  workout_history: {
    name: "workout_history",
    description: "List prior workouts.",
    inputSchema: workoutHistoryInputSchema
  },
  settings_get: {
    name: "settings_get",
    description: "Get the owner's locality and linked account status.",
    inputSchema: emptyInputSchema
  },
  settings_update: {
    name: "settings_update",
    description:
      "Update only the locality fields in the owner's direct instruction. Existing reminders keep their saved schedules.",
    inputSchema: {
      type: "object",
      properties: {
        timeZone: { type: "string" },
        locale: { type: "string" },
        hourCycle: { type: "string", enum: ["auto", "h12", "h23"] }
      },
      additionalProperties: false
    } as const
  },
  connection_list: {
    name: "connection_list",
    description: "List the owner's linked service status.",
    inputSchema: emptyInputSchema
  },
  connection_link_create: {
    name: "connection_link_create",
    description: "Create one short-lived account link for Google Calendar or Microsoft Calendar.",
    inputSchema: {
      type: "object",
      properties: {
        provider: {
          type: "string",
          enum: ["google_calendar", "microsoft_calendar"]
        }
      },
      required: ["provider"],
      additionalProperties: false
    } as const
  }
} as const satisfies {
  readonly [Name in ToolDefinitionName]: ToolDefinition<Name>
}

export { toolDefinitions }

/** Stable lookup for adapters that need one reviewed definition. */
export function toolDefinitionForName(name: ToolName): ToolDefinition | undefined {
  if (name === "memory_correct") return undefined
  return toolDefinitions[name]
}

const readOnlyToolNames = new Set<ToolName>([
  "reminder_list",
  "memory_search",
  "journal_search_metadata",
  "gym_list",
  "equipment_list",
  "exercise_list",
  "routine_get",
  "workout_last",
  "workout_history",
  "settings_get",
  "connection_list"
])

export function isReadOnlyToolName(name: ToolName): boolean {
  return readOnlyToolNames.has(name)
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "number") {
    return JSON.stringify(value)
  }
  if (typeof value === "string") return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`
  if (typeof value === "object") {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record)
      .toSorted()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`
  }
  throw new Error("Tool mutation identity contains an unsupported value")
}

function semanticMutationArguments(
  toolName: ToolName,
  argumentsValue: typeof JsonObject.Type
): typeof JsonObject.Type {
  if (toolName !== "reminder_create") return argumentsValue
  return Object.fromEntries(
    Object.entries(argumentsValue).filter(([key]) => key !== "sourceMessageId")
  )
}

/** Build one opaque mutation key for a conversation turn and canonical arguments. */
export async function conversationMutationIdempotencyKey(input: {
  readonly ownerId: string
  readonly conversationTurnId: string
  readonly toolName: ToolName
  readonly arguments: typeof JsonObject.Type
}): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(
      canonicalJson({
        version: 1,
        ownerId: input.ownerId,
        conversationTurnId: input.conversationTurnId,
        toolName: input.toolName,
        arguments: semanticMutationArguments(input.toolName, input.arguments)
      })
    )
  )
  const hash = [...new Uint8Array(digest)]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("")
  return `turn-mutation:sha256:${hash}`
}

export const ToolCommand = Schema.Struct({
  runId: Uuid,
  toolCallId: NonEmptyText,
  idempotencyKey: NonEmptyText,
  ownerId: Uuid,
  name: ToolName,
  arguments: JsonObject
})

export const ToolResult = Schema.Struct({
  ok: Schema.Boolean,
  code: NonEmptyText,
  message: ShortText,
  data: Schema.optionalKey(JsonObject)
})

export type ToolName = typeof ToolName.Type
export type MemorySearchArguments = typeof MemorySearchArguments.Type
export type MemoryProposeArguments = typeof MemoryProposeArguments.Type
export type MemoryConfirmArguments = typeof MemoryConfirmArguments.Type
export type JournalSearchMetadataArguments = typeof JournalSearchMetadataArguments.Type
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
export type SettingsUpdateArguments = typeof SettingsUpdateArguments.Type
export type ReminderCreateArguments = typeof ReminderCreateArguments.Type
export type ReminderOccurrenceArguments = typeof ReminderOccurrenceArguments.Type
export type ReminderSnoozeArguments = typeof ReminderSnoozeArguments.Type
export type ReminderCancelArguments = typeof ReminderCancelArguments.Type
export type ToolCommand = typeof ToolCommand.Type
export type ToolResult = typeof ToolResult.Type
export type ConnectionProviderArguments = typeof ConnectionProviderArguments.Type
