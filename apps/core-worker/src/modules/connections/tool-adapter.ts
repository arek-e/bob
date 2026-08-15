import {
  connectionsCapability,
  ConnectionProviderArguments
} from "@bob/contracts/capabilities/connections"
import { Schema } from "effect"

import type {
  ToolCommandAdapter,
  ToolCommandAdapterContext
} from "../conversations/tool-adapter.ts"
import type { ConnectionStore } from "./store.ts"

import { jsonObject } from "../../json.ts"

export function makeConnectionsToolAdapter(
  connections: ConnectionStore | undefined
): ToolCommandAdapter {
  return {
    capabilityId: connectionsCapability.id,
    names: connectionsCapability.names,
    async execute({ command }: ToolCommandAdapterContext) {
      switch (command.name) {
        case "connection_list":
          if (connections === undefined) throw new Error("Account connections are unavailable")
          return {
            ok: true,
            code: "connection_list",
            message: "The account connection status was found.",
            data: jsonObject({ connections: await connections.list(command.ownerId) })
          }
        case "connection_link_create": {
          if (connections === undefined) throw new Error("Account connections are unavailable")
          const args = Schema.decodeUnknownSync(ConnectionProviderArguments)(command.arguments)
          const session = await connections.createSession(command.ownerId, args.provider)
          return {
            ok: true,
            code: "connection_link_created",
            message: "Open the private account link. It expires in 30 minutes.",
            data: jsonObject(session)
          }
        }
        default:
          return {
            ok: false,
            code: "domain_error",
            message: "Bob could not complete this action safely."
          }
      }
    }
  }
}
