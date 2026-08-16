import type { CapabilityModule } from "@bob/core-capabilities-types/definitions"

import { emptyInputSchema } from "@bob/core-capabilities-types/definitions"
import { IsoDateTime } from "@bob/core-capabilities-types/shared"
import { Schema } from "effect"

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

export const connectionsCapability = {
  id: "connections",
  version: 1,
  feature: "settings",
  tools: [
    {
      kind: "model",
      name: "connection_list",
      description: "List the owner's linked service status.",
      inputSchema: emptyInputSchema,
      readOnly: true
    },
    {
      kind: "model",
      name: "connection_link_create",
      description:
        "Create one short-lived account link after the owner asks for Google Calendar or Microsoft Calendar.",
      inputSchema: {
        type: "object",
        properties: {
          provider: { type: "string", enum: ["google_calendar", "microsoft_calendar"] }
        },
        required: ["provider"],
        additionalProperties: false
      },
      externalOutcomeUnknown: true,
      confirmedActionCodes: ["connection_link_created"]
    }
  ]
} as const satisfies CapabilityModule
