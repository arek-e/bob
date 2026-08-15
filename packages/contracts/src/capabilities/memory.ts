import type { CapabilityModule, ToolDefinition, ToolDefinitionName } from "./definitions.ts"

import { idInputSchema } from "./definitions.ts"

export const memoryToolDefinitions = {
  memory_search: {
    name: "memory_search",
    description: "Find policy-cleared personal records with source labels.",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
      additionalProperties: false
    }
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
        assertionKind: { type: "string", enum: ["user_stated", "system_recorded", "inferred"] },
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
    }
  },
  memory_confirm: {
    name: "memory_confirm",
    description: "Confirm one owner-approved memory candidate.",
    inputSchema: idInputSchema
  }
} as const satisfies Readonly<Partial<Record<ToolDefinitionName, ToolDefinition>>>

export const memoryCapability = {
  id: "memory",
  version: 1,
  feature: "memory",
  names: ["memory_search", "memory_propose", "memory_confirm", "memory_correct"],
  definitions: memoryToolDefinitions,
  readOnly: ["memory_search"],
  sourceBound: ["memory_propose"],
  externalOutcomeUnknown: []
} as const satisfies CapabilityModule
