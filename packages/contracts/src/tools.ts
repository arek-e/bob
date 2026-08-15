import { Schema } from "effect"

import { connectionsCapability, connectionToolDefinitions } from "./capabilities/connections.ts"
import {
  ToolName,
  type CapabilityModule,
  type ModelToolName,
  type ToolDefinition,
  type ToolDefinitionName
} from "./capabilities/definitions.ts"
import { journalCapability, journalToolDefinitions } from "./capabilities/journal.ts"
import { memoryCapability, memoryToolDefinitions } from "./capabilities/memory.ts"
import { reminderCapability, reminderToolDefinitions } from "./capabilities/reminders.ts"
import { settingsCapability, settingsToolDefinitions } from "./capabilities/settings.ts"
import { trainingCapability, trainingToolDefinitions } from "./capabilities/training.ts"
import { IsoDateTime, JsonObject, NonEmptyText, ShortText, TimeZone, Uuid } from "./shared.ts"

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

export const capabilityModules = Object.freeze([
  reminderCapability,
  memoryCapability,
  journalCapability,
  trainingCapability,
  settingsCapability,
  connectionsCapability
] as const satisfies readonly CapabilityModule[])

export const coreCapabilityModules = Object.freeze([
  memoryCapability,
  settingsCapability
] as const satisfies readonly CapabilityModule[])

export type CapabilityProfile = "core" | "full"

export interface CapabilityCatalogue {
  readonly profile: CapabilityProfile
  readonly modules: readonly CapabilityModule[]
  readonly names: readonly ToolName[]
  readonly generation: CapabilityCatalogueGeneration
}

const toolDefinitions = {
  ...reminderToolDefinitions,
  ...memoryToolDefinitions,
  ...journalToolDefinitions,
  ...trainingToolDefinitions,
  ...settingsToolDefinitions,
  ...connectionToolDefinitions
} as const satisfies {
  readonly [Name in ToolDefinitionName]: ToolDefinition<Name>
}

const capabilityByToolName = new Map(
  capabilityModules.flatMap((capability) =>
    capability.names.map((name) => [name, capability] as const)
  )
)

export function validateCapabilityModules(
  modules: readonly CapabilityModule[],
  options: { readonly requireAllTools?: boolean } = {}
): void {
  const ids = modules.map((capability) => capability.id)
  if (new Set(ids).size !== ids.length) throw new Error("Duplicate capability ID")
  const names = modules.flatMap((capability) => capability.names)
  if (new Set(names).size !== names.length) throw new Error("Duplicate capability Tool name")
  if (
    (options.requireAllTools === true && names.length !== ToolName.literals.length) ||
    (options.requireAllTools === true && ToolName.literals.some((name) => !names.includes(name)))
  ) {
    throw new Error("Capability catalogue does not own every Tool name")
  }
  for (const capability of modules) {
    const owned = new Set<ToolName>(capability.names)
    const policies = [
      capability.readOnly,
      capability.sourceBound,
      capability.externalOutcomeUnknown
    ]
    if (policies.some((items) => items.some((name) => !owned.has(name)))) {
      throw new Error(`Capability ${capability.id} declares policy for an unowned Tool`)
    }
    if (
      Object.keys(capability.definitions).some(
        (name) => !owned.has(Schema.decodeUnknownSync(ToolName)(name))
      )
    ) {
      throw new Error(`Capability ${capability.id} defines an unowned Tool`)
    }
  }
}

export function validateCapabilityCatalogue(): void {
  validateCapabilityModules(capabilityModules, { requireAllTools: true })
}

validateCapabilityCatalogue()

function catalogueFingerprint(value: typeof Schema.Json.Type): string {
  let hash = 14_695_981_039_346_656_037n
  const canonicalValue = canonicalJson(value)
  for (const byte of new TextEncoder().encode(canonicalValue)) {
    hash ^= BigInt(byte)
    hash = BigInt.asUintN(64, hash * 1_099_511_628_211n)
  }
  return hash.toString(16).padStart(16, "0")
}

export const CapabilityCatalogueGeneration = Schema.String.check(
  Schema.isPattern(/^capability-v1:[0-9a-f]{16}$/)
)

export function makeCapabilityCatalogue(
  profile: CapabilityProfile,
  modules: readonly CapabilityModule[]
): CapabilityCatalogue {
  validateCapabilityModules(modules)
  const generation = Schema.decodeUnknownSync(CapabilityCatalogueGeneration)(
    `capability-v1:${catalogueFingerprint(Schema.decodeUnknownSync(Schema.Json)(modules))}`
  )
  return Object.freeze({
    profile,
    modules: Object.freeze([...modules]),
    names: Object.freeze(modules.flatMap((capability) => capability.names)),
    generation
  })
}

export const coreCapabilityCatalogue = makeCapabilityCatalogue("core", coreCapabilityModules)
export const fullCapabilityCatalogue = makeCapabilityCatalogue("full", capabilityModules)

/** Content identity for the complete reviewed catalogue and its safety policy. */
export const capabilityCatalogueGeneration = Schema.decodeUnknownSync(
  CapabilityCatalogueGeneration
)(`capability-v1:${catalogueFingerprint(Schema.decodeUnknownSync(Schema.Json)(capabilityModules))}`)

export { toolDefinitions }

/** Every reviewed capability that the model can choose during a turn. */
export const modelToolNames: readonly ModelToolName[] = Object.freeze(
  Object.values(toolDefinitions)
    .map((definition) => definition.name)
    .filter((name): name is ModelToolName => name !== "memory_confirm")
)

/** Stable lookup for adapters that need one reviewed definition. */
export function toolDefinitionForName(name: ToolName): ToolDefinition | undefined {
  if (name === "memory_correct") return undefined
  return toolDefinitions[name]
}

export function capabilityForToolName(name: ToolName): CapabilityModule {
  const capability = capabilityByToolName.get(name)
  if (capability === undefined) throw new Error(`No capability owns Tool ${name}`)
  return capability
}

export function isReadOnlyToolName(name: ToolName): boolean {
  return capabilityForToolName(name).readOnly.some((candidate) => candidate === name)
}

export function isSourceBoundToolName(name: ToolName): boolean {
  return capabilityForToolName(name).sourceBound.some((candidate) => candidate === name)
}

export function hasUnknownExternalOutcome(name: ToolName): boolean {
  return capabilityForToolName(name).externalOutcomeUnknown.some((candidate) => candidate === name)
}

function isJsonObject(value: typeof Schema.Json.Type): value is typeof JsonObject.Type {
  return value !== null && !Array.isArray(value) && Object(value) === value
}

function canonicalJson(value: typeof Schema.Json.Type): string {
  if (value === null) return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`
  if (isJsonObject(value)) {
    return `{${Object.keys(value)
      .toSorted()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key] ?? null)}`)
      .join(",")}}`
  }
  return JSON.stringify(value)
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

export type CapabilityCatalogueGeneration = typeof CapabilityCatalogueGeneration.Type
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

export { ToolName }
export {
  connectionsCapability,
  journalCapability,
  memoryCapability,
  reminderCapability,
  settingsCapability,
  trainingCapability
}
export type {
  CapabilityFeature,
  CapabilityId,
  CapabilityModule,
  ModelToolName,
  ToolDefinition,
  ToolDefinitionName,
  ToolInputPropertySchema,
  ToolInputSchema
} from "./capabilities/definitions.ts"
