import type {
  ToolCommandAdapter,
  ToolCommandAdapterContext
} from "@bob/conversations-types/tool-adapter"

import { jsonObject } from "@bob/capabilities-types/json"
import { capabilityToolNames } from "@bob/capabilities-types/tools"
import { settingsCapability, SettingsUpdateArguments } from "@bob/settings-types/capability"
import { Schema } from "effect"

import type { OwnerSettingsStoreAdapter } from "./store.ts"

import { isSettingsMutationRequest, settingsUpdateMatchesRequest } from "./rules.ts"

export function makeSettingsToolAdapter(
  settings: OwnerSettingsStoreAdapter | undefined
): ToolCommandAdapter {
  return {
    capabilityId: settingsCapability.id,
    names: capabilityToolNames(settingsCapability),
    async execute({ command, run }: ToolCommandAdapterContext) {
      switch (command.name) {
        case "settings_get": {
          if (settings === undefined) throw new Error("Owner settings are unavailable")
          const ownerSettings = await settings.get(command.ownerId)
          return {
            ok: true,
            code: "owner_settings",
            message: "The owner settings were found.",
            data: jsonObject({ settings: ownerSettings })
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
                : `Time zone saved as ${ownerSettings.timeZone}.`,
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
