import type { ToolCommandAdapter, ToolCommandAdapterContext } from "@bob/tools-types/adapter"

import {
  connectionsCapability,
  ConnectionProviderArguments
} from "@bob/connections-types/capability"
import { jsonObject } from "@bob/shared-types/json"
import { fromPromiseToolExecution } from "@bob/tools-service/adapter"
import { capabilityToolNames } from "@bob/tools-types/tools"
import { Schema } from "effect"

import type { ConnectionStore } from "./store.ts"

export function makeConnectionsToolAdapter(
  connections: ConnectionStore | undefined
): ToolCommandAdapter {
  return {
    capabilityId: connectionsCapability.id,
    names: capabilityToolNames(connectionsCapability),
    execute({ command }: ToolCommandAdapterContext) {
      return fromPromiseToolExecution(connectionsCapability.id, async () => {
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
      })
    }
  }
}
