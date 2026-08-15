import { Schema } from "effect"

import type { CapabilityModule, ModelToolName, ToolDefinition, ToolName } from "./definitions.ts"

import { CapabilityId } from "./definitions.ts"

export const DeploymentProfileId = Schema.String.check(
  Schema.isPattern(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/),
  Schema.isMaxLength(64)
)

export const CapabilityCatalogueGeneration = Schema.String.check(
  Schema.isPattern(/^capability-v2:[0-9a-f]{16}$/)
)

export type DeploymentProfileId = typeof DeploymentProfileId.Type
export type CapabilityCatalogueGenerationValue = typeof CapabilityCatalogueGeneration.Type

export interface CapabilityCatalogue {
  readonly profileId: DeploymentProfileId
  readonly modules: readonly CapabilityModule[]
  readonly names: readonly ToolName[]
  readonly modelToolNames: readonly ModelToolName[]
  readonly generation: CapabilityCatalogueGenerationValue
  moduleFor(name: ToolName): CapabilityModule | undefined
  definitionFor(name: ToolName): ToolDefinition | undefined
  isReadOnly(name: ToolName): boolean
  isSourceBound(name: ToolName): boolean
  hasUnknownExternalOutcome(name: ToolName): boolean
  confirmedActionCodes(name: ToolName): readonly string[]
  mutationArgumentExclusions(name: ToolName): readonly string[]
  sourceMessageArgument(name: ToolName): string | undefined
}

function isJsonObject(
  value: typeof Schema.Json.Type
): value is Readonly<Record<string, Schema.Json>> {
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

function fingerprint(value: typeof Schema.Json.Type): string {
  let hash = 14_695_981_039_346_656_037n
  for (const byte of new TextEncoder().encode(canonicalJson(value))) {
    hash ^= BigInt(byte)
    hash = BigInt.asUintN(64, hash * 1_099_511_628_211n)
  }
  return hash.toString(16).padStart(16, "0")
}

export function validateCapabilityModules(modules: readonly CapabilityModule[]): void {
  const ids = modules.map((module) => module.id)
  if (new Set(ids).size !== ids.length) throw new Error("Duplicate Capability Module ID")
  const names = modules.flatMap((module) => module.names)
  if (new Set(names).size !== names.length) throw new Error("Duplicate Tool ownership")

  for (const module of modules) {
    Schema.decodeUnknownSync(CapabilityId)(module.id)
    const owned = new Set(module.names)
    const declaredNames = [
      ...Object.keys(module.definitions),
      ...module.modelTools,
      ...module.readOnly,
      ...module.sourceBound,
      ...module.externalOutcomeUnknown,
      ...Object.keys(module.confirmedActionCodes),
      ...Object.keys(module.mutationArgumentExclusions),
      ...Object.keys(module.sourceMessageArguments)
    ]
    if (declaredNames.some((name) => !owned.has(name))) {
      throw new Error(`Capability Module ${module.id} declares an unowned Tool`)
    }
    if (Object.values(module.definitions).some((definition) => definition?.name === undefined)) {
      throw new Error(`Capability Module ${module.id} has an invalid Tool definition`)
    }
    if (module.modelTools.some((name) => module.definitions[name] === undefined)) {
      throw new Error(`Capability Module ${module.id} exposes a Tool without a definition`)
    }
  }
}

export function makeCapabilityCatalogue(
  profileId: DeploymentProfileId,
  modules: readonly CapabilityModule[]
): CapabilityCatalogue {
  Schema.decodeUnknownSync(DeploymentProfileId)(profileId)
  validateCapabilityModules(modules)
  const frozenModules = Object.freeze([...modules])
  const names = Object.freeze(frozenModules.flatMap((module) => module.names))
  const moduleByName = new Map(
    names.map(
      (name) => [name, frozenModules.find((module) => module.names.includes(name))!] as const
    )
  )
  const definitions = new Map(
    frozenModules.flatMap((module) =>
      Object.values(module.definitions).flatMap((definition) =>
        definition === undefined ? [] : [[definition.name, definition] as const]
      )
    )
  )
  const generation = Schema.decodeUnknownSync(CapabilityCatalogueGeneration)(
    `capability-v2:${fingerprint(Schema.decodeUnknownSync(Schema.Json)({ profileId, modules: frozenModules }))}`
  )
  const policyNames = (
    name: ToolName,
    key: "confirmedActionCodes" | "mutationArgumentExclusions"
  ) => moduleByName.get(name)?.[key][name] ?? []

  return Object.freeze({
    profileId,
    modules: frozenModules,
    names,
    modelToolNames: Object.freeze(frozenModules.flatMap((module) => module.modelTools)),
    generation,
    moduleFor: (name: ToolName) => moduleByName.get(name),
    definitionFor: (name: ToolName) => definitions.get(name),
    isReadOnly: (name: ToolName) => moduleByName.get(name)?.readOnly.includes(name) === true,
    isSourceBound: (name: ToolName) => moduleByName.get(name)?.sourceBound.includes(name) === true,
    hasUnknownExternalOutcome: (name: ToolName) =>
      moduleByName.get(name)?.externalOutcomeUnknown.includes(name) === true,
    confirmedActionCodes: (name: ToolName) => policyNames(name, "confirmedActionCodes"),
    mutationArgumentExclusions: (name: ToolName) => policyNames(name, "mutationArgumentExclusions"),
    sourceMessageArgument: (name: ToolName) => moduleByName.get(name)?.sourceMessageArguments[name]
  })
}
