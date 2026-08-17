import type { ToolCommandAdapter, ToolCommandAdapterContext } from "@bob/tools-types/adapter"

import { settingsCapability, SettingsUpdateArguments } from "@bob/settings-types/capability"
import { jsonObject } from "@bob/shared-types/json"
import { fromPromiseToolExecution } from "@bob/tools-service/adapter"
import { capabilityToolNames } from "@bob/tools-types/tools"
import { Schema } from "effect"

import type { OwnerSettingsStoreAdapter } from "./store.ts"

import { isSettingsMutationRequest, settingsUpdateMatchesRequest } from "./rules.ts"

export function makeSettingsToolAdapter(
  settings: OwnerSettingsStoreAdapter | undefined
): ToolCommandAdapter {
  return {
    capabilityId: settingsCapability.id,
    names: capabilityToolNames(settingsCapability),
    execute({ command, run }: ToolCommandAdapterContext) {
      return fromPromiseToolExecution(settingsCapability.id, async () => {
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
              !isSettingsMutationRequest(run.userText) ||
              !settingsUpdateMatchesRequest(run.userText, input)
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
      })
    }
  }
}
