import type { CapabilityModule } from "@bob/capabilities-types/definitions"

import { emptyInputSchema } from "@bob/capabilities-types/definitions"
import { TimeZone } from "@bob/capabilities-types/shared"
import { Schema } from "effect"

export const SettingsUpdateArguments = Schema.Struct({
  timeZone: Schema.optionalKey(TimeZone),
  locale: Schema.optionalKey(Schema.String),
  hourCycle: Schema.optionalKey(Schema.Literals(["auto", "h12", "h23"]))
})
export type SettingsUpdateArguments = typeof SettingsUpdateArguments.Type

export const settingsCapability = {
  id: "settings",
  version: 1,
  feature: "settings",
  tools: [
    {
      kind: "model",
      name: "settings_get",
      description: "Get the owner's locality settings.",
      inputSchema: emptyInputSchema,
      readOnly: true
    },
    {
      kind: "model",
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
      },
      confirmedActionCodes: ["owner_settings_updated"]
    }
  ]
} as const satisfies CapabilityModule
