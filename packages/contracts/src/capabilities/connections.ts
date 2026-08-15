import { Schema } from "effect"

import type { CapabilityModule, ToolDefinition, ToolDefinitionName } from "./definitions.ts"

import { IsoDateTime } from "../shared.ts"
import { emptyInputSchema } from "./definitions.ts"

export const ConnectionProvider = Schema.Literals(["google_calendar", "microsoft_calendar"])
export const ConnectionStatus = Schema.Literals(["connected", "not_connected", "unavailable"])
export const ConnectionView = Schema.Struct({
  provider: ConnectionProvider,
  status: ConnectionStatus
})
export const ConnectionList = Schema.Struct({ connections: Schema.Array(ConnectionView) })
export const ConnectionSession = Schema.Struct({
  provider: ConnectionProvider,
  connectUrl: Schema.String,
  expiresAt: IsoDateTime
})

export type ConnectionProvider = typeof ConnectionProvider.Type
export type ConnectionStatus = typeof ConnectionStatus.Type
export type ConnectionView = typeof ConnectionView.Type
export type ConnectionSession = typeof ConnectionSession.Type

export const ConnectionProviderArguments = Schema.Struct({
  provider: Schema.Literals(["google_calendar", "microsoft_calendar"])
})
export type ConnectionProviderArguments = typeof ConnectionProviderArguments.Type

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
  modelTools: ["connection_list", "connection_link_create"],
  definitions: connectionToolDefinitions,
  readOnly: ["connection_list"],
  sourceBound: [],
  externalOutcomeUnknown: ["connection_link_create"],
  confirmedActionCodes: { connection_link_create: ["connection_link_created"] },
  mutationArgumentExclusions: {},
  sourceMessageArguments: {}
} as const satisfies CapabilityModule
