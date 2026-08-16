import { Schema } from "effect"

import type { CapabilityModule } from "./definitions.ts"

import { idInputSchema } from "./definitions.ts"

export const MemorySearchArguments = Schema.Struct({ query: Schema.String })
export const MemoryProposeArguments = Schema.Struct({
  scope: Schema.String,
  key: Schema.String,
  value: Schema.Json,
  canonicalText: Schema.String,
  extractionConfidence: Schema.Number,
  importance: Schema.Number,
  explicitRemember: Schema.Boolean
})
export const MemoryConfirmArguments = Schema.Struct({ id: Schema.String })
export type MemorySearchArguments = typeof MemorySearchArguments.Type
export type MemoryProposeArguments = typeof MemoryProposeArguments.Type
export type MemoryConfirmArguments = typeof MemoryConfirmArguments.Type

export const memoryCapability = {
  id: "memory",
  version: 2,
  feature: "memory",
  tools: [
    {
      kind: "model",
      name: "memory_search",
      description: "Find policy-cleared personal records with source labels.",
      inputSchema: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
        additionalProperties: false
      },
      readOnly: true
    },
    {
      kind: "model",
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
          extractionConfidence: { type: "number" },
          importance: { type: "number" },
          explicitRemember: { type: "boolean" }
        },
        required: [
          "scope",
          "key",
          "value",
          "canonicalText",
          "extractionConfidence",
          "importance",
          "explicitRemember"
        ],
        additionalProperties: false
      },
      sourceBound: true
    },
    {
      kind: "deterministic",
      name: "memory_confirm",
      definition: {
        description: "Confirm one owner-approved memory candidate.",
        inputSchema: idInputSchema
      },
      confirmedActionCodes: ["memory_confirmed"]
    },
    { kind: "deterministic", name: "memory_correct" }
  ]
} as const satisfies CapabilityModule
