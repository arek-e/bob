import { Schema } from "effect"

import type {
  CapabilityModule,
  CapabilityToolRegistration,
  ModelToolName,
  ToolDefinition
} from "./definitions.ts"

import { CapabilityId, ToolName } from "./definitions.ts"

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
  const names = modules.flatMap((module) => module.tools.map((tool) => tool.name))
  if (new Set(names).size !== names.length) throw new Error("Duplicate Tool ownership")

  for (const module of modules) {
    Schema.decodeUnknownSync(CapabilityId)(module.id)
    for (const tool of module.tools) {
      Schema.decodeUnknownSync(ToolName)(tool.name)
      if (tool.kind === "model" && tool.description.length === 0) {
        throw new Error(`Capability Module ${module.id} has an invalid Tool definition`)
      }
    }
  }
}

function capabilityGenerationView(module: CapabilityModule): typeof Schema.Json.Type {
  const tools = module.tools
  const policyRecord = <Value>(
    select: (tool: CapabilityToolRegistration) => Value | undefined
  ): Record<string, Value> =>
    Object.fromEntries(
      tools.flatMap((tool) => {
        const value = select(tool)
        return value === undefined ? [] : [[tool.name, value]]
      })
    )

  return Schema.decodeUnknownSync(Schema.Json)({
    id: module.id,
    version: module.version,
    feature: module.feature,
    names: tools.map((tool) => tool.name),
    modelTools: tools.filter((tool) => tool.kind === "model").map((tool) => tool.name),
    definitions: policyRecord((tool) => {
      if (tool.kind === "model") {
        return { name: tool.name, description: tool.description, inputSchema: tool.inputSchema }
      }
      return tool.definition === undefined ? undefined : { name: tool.name, ...tool.definition }
    }),
    readOnly: tools.filter((tool) => tool.readOnly === true).map((tool) => tool.name),
    sourceBound: tools.filter((tool) => tool.sourceBound === true).map((tool) => tool.name),
    externalOutcomeUnknown: tools
      .filter((tool) => tool.externalOutcomeUnknown === true)
      .map((tool) => tool.name),
    confirmedActionCodes: policyRecord((tool) => tool.confirmedActionCodes),
    mutationArgumentExclusions: policyRecord((tool) => tool.mutationArgumentExclusions),
    sourceMessageArguments: policyRecord((tool) => tool.sourceMessageArgument)
  })
}

export function makeCapabilityCatalogue(
  profileId: DeploymentProfileId,
  modules: readonly CapabilityModule[]
): CapabilityCatalogue {
  Schema.decodeUnknownSync(DeploymentProfileId)(profileId)
  validateCapabilityModules(modules)
  const frozenModules = Object.freeze([...modules])
  const registrations = frozenModules.flatMap((module) =>
    module.tools.map((tool) => ({ module, tool }))
  )
  const names = Object.freeze(registrations.map(({ tool }) => tool.name))
  const moduleByName = new Map(
    registrations.map(({ module, tool }) => [tool.name, module] as const)
  )
  const definitions = new Map(
    registrations.flatMap(({ tool }) => {
      if (tool.kind === "model") {
        return [
          [
            tool.name,
            { name: tool.name, description: tool.description, inputSchema: tool.inputSchema }
          ] as const
        ]
      }
      return tool.definition === undefined
        ? []
        : [[tool.name, { name: tool.name, ...tool.definition }] as const]
    })
  )
  const registrationByName = new Map(registrations.map(({ tool }) => [tool.name, tool] as const))
  const generation = Schema.decodeUnknownSync(CapabilityCatalogueGeneration)(
    `capability-v2:${fingerprint(
      Schema.decodeUnknownSync(Schema.Json)({
        profileId,
        modules: frozenModules.map(capabilityGenerationView)
      })
    )}`
  )

  return Object.freeze({
    profileId,
    modules: frozenModules,
    names,
    modelToolNames: Object.freeze(
      registrations.flatMap(({ tool }) => (tool.kind === "model" ? [tool.name] : []))
    ),
    generation,
    moduleFor: (name: ToolName) => moduleByName.get(name),
    definitionFor: (name: ToolName) => definitions.get(name),
    isReadOnly: (name: ToolName) => registrationByName.get(name)?.readOnly === true,
    isSourceBound: (name: ToolName) => registrationByName.get(name)?.sourceBound === true,
    hasUnknownExternalOutcome: (name: ToolName) =>
      registrationByName.get(name)?.externalOutcomeUnknown === true,
    confirmedActionCodes: (name: ToolName) =>
      registrationByName.get(name)?.confirmedActionCodes ?? [],
    mutationArgumentExclusions: (name: ToolName) =>
      registrationByName.get(name)?.mutationArgumentExclusions ?? [],
    sourceMessageArgument: (name: ToolName) => registrationByName.get(name)?.sourceMessageArgument
  })
}
