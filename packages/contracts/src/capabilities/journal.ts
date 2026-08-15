import type { CapabilityModule, ToolDefinition, ToolDefinitionName } from "./definitions.ts"

import { emptyInputSchema } from "./definitions.ts"

export const journalToolDefinitions = {
  journal_link_create: {
    name: "journal_link_create",
    description:
      "Create a private short-lived journal link after the owner asks. Never accept journal text.",
    inputSchema: emptyInputSchema
  },
  journal_search_metadata: {
    name: "journal_search_metadata",
    description: "Find journal dates and tags. Journal text and summaries stay private.",
    inputSchema: {
      type: "object",
      properties: { tag: { type: "string" } },
      additionalProperties: false
    }
  }
} as const satisfies Readonly<Partial<Record<ToolDefinitionName, ToolDefinition>>>

export const journalCapability = {
  id: "journal",
  version: 1,
  feature: "journal",
  names: ["journal_link_create", "journal_search_metadata"],
  definitions: journalToolDefinitions,
  readOnly: ["journal_search_metadata"],
  sourceBound: [],
  externalOutcomeUnknown: []
} as const satisfies CapabilityModule
