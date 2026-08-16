import { Schema } from "effect"

import { CapabilityCatalogueGeneration, makeCapabilityCatalogue } from "./capabilities/catalogue.ts"
import { ToolName } from "./capabilities/definitions.ts"
import { IsoDateTime, JsonObject, NonEmptyText, ShortText, Uuid } from "./shared.ts"

export const MAX_TOOL_RESULT_BYTES = 32 * 1024

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
  argumentsValue: typeof JsonObject.Type,
  excludedArgumentNames: readonly string[]
): typeof JsonObject.Type {
  return Object.fromEntries(
    Object.entries(argumentsValue).filter(([key]) => !excludedArgumentNames.includes(key))
  )
}

/** Build one opaque mutation key for a conversation turn and canonical arguments. */
export async function conversationMutationIdempotencyKey(input: {
  readonly ownerId: string
  readonly conversationTurnId: string
  readonly toolName: ToolName
  readonly arguments: typeof JsonObject.Type
  readonly excludedArgumentNames?: readonly string[]
}): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(
      canonicalJson({
        version: 1,
        ownerId: input.ownerId,
        conversationTurnId: input.conversationTurnId,
        toolName: input.toolName,
        arguments: semanticMutationArguments(input.arguments, input.excludedArgumentNames ?? [])
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

export const ToolEvidence = Schema.Struct({
  actionOutcome: Schema.optionalKey(Schema.Literals(["confirmed", "proposed", "unknown"])),
  sources: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        sourceId: NonEmptyText,
        sourceLabel: ShortText,
        occurredAt: Schema.optionalKey(IsoDateTime)
      })
    ).check(Schema.isMaxLength(24))
  ),
  responseText: Schema.optionalKey(ShortText)
})

export const ToolResult = Schema.Struct({
  ok: Schema.Boolean,
  code: NonEmptyText,
  message: ShortText,
  data: Schema.optionalKey(JsonObject),
  evidence: Schema.optionalKey(ToolEvidence)
}).check(
  Schema.makeFilter((result) =>
    new TextEncoder().encode(JSON.stringify(result)).byteLength <= MAX_TOOL_RESULT_BYTES
      ? undefined
      : { path: [], issue: "Tool result exceeds the byte limit" }
  )
)

export type ToolCommand = typeof ToolCommand.Type
export type ToolResult = typeof ToolResult.Type
export type ToolEvidence = typeof ToolEvidence.Type

export { ToolName }
export { CapabilityCatalogueGeneration, makeCapabilityCatalogue }
export type { CapabilityCatalogue } from "./capabilities/catalogue.ts"
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
