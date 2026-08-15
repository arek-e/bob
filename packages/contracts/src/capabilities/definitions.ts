import { Schema } from "effect"

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

export type ToolName = typeof ToolName.Type
export type ToolDefinitionName = Exclude<ToolName, "memory_correct">
export type ModelToolName = Exclude<ToolDefinitionName, "memory_confirm">

export interface ToolDefinition<Name extends ToolDefinitionName = ToolDefinitionName> {
  readonly name: Name
  readonly description: string
  readonly inputSchema: ToolInputSchema
}

export type CapabilityId =
  | "reminders"
  | "memory"
  | "journal"
  | "training"
  | "settings"
  | "connections"

export type CapabilityFeature = "reminders" | "memory" | "journal" | "training" | "settings"

export interface CapabilityModule {
  readonly id: CapabilityId
  readonly version: number
  readonly feature: CapabilityFeature
  readonly names: readonly ToolName[]
  readonly definitions: Readonly<Partial<Record<ToolDefinitionName, ToolDefinition>>>
  readonly readOnly: readonly ToolName[]
  readonly sourceBound: readonly ToolName[]
  readonly externalOutcomeUnknown: readonly ToolName[]
}

export const emptyInputSchema = {
  type: "object",
  properties: {},
  additionalProperties: false
} as const satisfies ToolInputSchema

export const idInputSchema = {
  type: "object",
  properties: { id: { type: "string" } },
  required: ["id"],
  additionalProperties: false
} as const satisfies ToolInputSchema

export const occurrenceInputSchema = {
  type: "object",
  properties: { occurrenceId: { type: "string" } },
  required: ["occurrenceId"],
  additionalProperties: false
} as const satisfies ToolInputSchema
