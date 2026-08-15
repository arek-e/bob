import { Schema } from "effect"

export const ToolName = Schema.String.check(
  Schema.isPattern(/^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/),
  Schema.isMaxLength(80)
)

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
export type ToolDefinitionName = ToolName
export type ModelToolName = ToolName

export interface ToolDefinition<Name extends ToolDefinitionName = ToolDefinitionName> {
  readonly name: Name
  readonly description: string
  readonly inputSchema: ToolInputSchema
}

export const CapabilityId = Schema.String.check(
  Schema.isPattern(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/),
  Schema.isMaxLength(64)
)

export type CapabilityId = typeof CapabilityId.Type
export type CapabilityFeature = string

export interface CapabilityModule {
  readonly id: CapabilityId
  readonly version: number
  readonly feature: CapabilityFeature
  readonly names: readonly ToolName[]
  readonly modelTools: readonly ToolName[]
  readonly definitions: Readonly<Partial<Record<ToolDefinitionName, ToolDefinition>>>
  readonly readOnly: readonly ToolName[]
  readonly sourceBound: readonly ToolName[]
  readonly externalOutcomeUnknown: readonly ToolName[]
  readonly confirmedActionCodes: Readonly<Partial<Record<ToolName, readonly string[]>>>
  readonly mutationArgumentExclusions: Readonly<Partial<Record<ToolName, readonly string[]>>>
  readonly sourceMessageArguments: Readonly<Partial<Record<ToolName, string>>>
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
