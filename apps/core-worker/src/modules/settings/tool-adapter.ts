import { SettingsUpdateArguments } from "@bob/contracts/tools"
import { Schema } from "effect"

import type { AccountConnections } from "../connections/store.ts"
import type {
  ToolCommandAdapter,
  ToolCommandAdapterContext
} from "../conversations/tool-adapter.ts"
import type { OwnerSettingsStore } from "./store.ts"

import { isSettingsMutationRequest, settingsUpdateMatchesRequest } from "./rules.ts"

type JsonValue = typeof Schema.Json.Type

function jsonObject(value: unknown): { readonly [key: string]: JsonValue } {
  return JSON.parse(JSON.stringify(value)) as { readonly [key: string]: JsonValue }
}

export function makeSettingsToolAdapter(
  settings: OwnerSettingsStore | undefined,
  connections: AccountConnections | undefined
): ToolCommandAdapter {
  async function connectionStatus(ownerId: string) {
    if (settings === undefined) throw new Error("Owner settings are unavailable")
    return connections === undefined ? [] : connections.list(ownerId)
  }

  return {
    async execute({ command, run }: ToolCommandAdapterContext) {
      switch (command.name) {
        case "settings_get": {
          if (settings === undefined) throw new Error("Owner settings are unavailable")
          const ownerSettings = await settings.get(command.ownerId)
          return {
            ok: true,
            code: "owner_settings",
            message: "The owner settings were found.",
            data: jsonObject({
              settings: ownerSettings,
              connections: await connectionStatus(command.ownerId)
            })
          }
        }
        case "settings_update": {
          if (settings === undefined) throw new Error("Owner settings are unavailable")
          const input = Schema.decodeUnknownSync(SettingsUpdateArguments)(command.arguments)
          if (
            !isSettingsMutationRequest(run.request.userText) ||
            !settingsUpdateMatchesRequest(run.request.userText, input)
          ) {
            return {
              ok: false,
              code: "confirmation_required",
              message: "Ask for a direct instruction for each owner setting before changing it."
            }
          }
          const ownerSettings = await settings.update(
            command.ownerId,
            input,
            command.idempotencyKey
          )
          return {
            ok: true,
            code: "owner_settings_updated",
            message:
              input.timeZone === undefined
                ? "Locality settings saved."
                : `Time zone saved as ${ownerSettings.timeZone}. Existing reminders keep their saved schedules.`,
            data: jsonObject({ settings: ownerSettings })
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
