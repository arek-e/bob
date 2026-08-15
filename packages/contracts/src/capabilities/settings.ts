import { Schema } from "effect"

import type { CapabilityModule, ToolDefinition, ToolDefinitionName } from "./definitions.ts"

import { TimeZone } from "../shared.ts"
import { emptyInputSchema } from "./definitions.ts"

export const SettingsUpdateArguments = Schema.Struct({
  timeZone: Schema.optionalKey(TimeZone),
  locale: Schema.optionalKey(Schema.String),
  hourCycle: Schema.optionalKey(Schema.Literals(["auto", "h12", "h23"]))
})
export type SettingsUpdateArguments = typeof SettingsUpdateArguments.Type

export const settingsToolDefinitions = {
  settings_get: {
    name: "settings_get",
    description: "Get the owner's locality settings.",
    inputSchema: emptyInputSchema
  },
  settings_update: {
    name: "settings_update",
    description: "Update only the locality fields in the owner's direct instruction.",
    inputSchema: {
      type: "object",
      properties: {
        timeZone: { type: "string" },
        locale: { type: "string" },
        hourCycle: { type: "string", enum: ["auto", "h12", "h23"] }
      },
      additionalProperties: false
    }
  }
} as const satisfies Readonly<Partial<Record<ToolDefinitionName, ToolDefinition>>>

export const settingsCapability = {
  id: "settings",
  version: 1,
  feature: "settings",
  names: ["settings_get", "settings_update"],
  modelTools: ["settings_get", "settings_update"],
  definitions: settingsToolDefinitions,
  readOnly: ["settings_get"],
  sourceBound: [],
  externalOutcomeUnknown: [],
  confirmedActionCodes: { settings_update: ["owner_settings_updated"] },
  mutationArgumentExclusions: {},
  sourceMessageArguments: {}
} as const satisfies CapabilityModule
