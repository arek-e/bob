import type { CapabilityModule, ToolDefinition, ToolDefinitionName } from "./definitions.ts"

import { emptyInputSchema } from "./definitions.ts"

export const connectionToolDefinitions = {
  connection_list: {
    name: "connection_list",
    description: "List the owner's linked service status.",
    inputSchema: emptyInputSchema
  },
  connection_link_create: {
    name: "connection_link_create",
    description:
      "Create one short-lived account link after the owner asks for Google Calendar or Microsoft Calendar.",
    inputSchema: {
      type: "object",
      properties: { provider: { type: "string", enum: ["google_calendar", "microsoft_calendar"] } },
      required: ["provider"],
      additionalProperties: false
    }
  }
} as const satisfies Readonly<Partial<Record<ToolDefinitionName, ToolDefinition>>>

export const connectionsCapability = {
  id: "connections",
  version: 1,
  feature: "settings",
  names: ["connection_list", "connection_link_create"],
  definitions: connectionToolDefinitions,
  readOnly: ["connection_list"],
  sourceBound: [],
  externalOutcomeUnknown: ["connection_link_create"]
} as const satisfies CapabilityModule
