import { Schema } from "effect"

import { IsoDateTime, Locale, TimeZone } from "./shared.ts"

export const HourCycle = Schema.Literals(["auto", "h12", "h23"])

export const OwnerSettings = Schema.Struct({
  timeZone: TimeZone,
  locale: Locale,
  hourCycle: HourCycle,
  updatedAt: IsoDateTime
})

export const OwnerSettingsUpdate = Schema.Struct({
  timeZone: Schema.optionalKey(TimeZone),
  locale: Schema.optionalKey(Locale),
  hourCycle: Schema.optionalKey(HourCycle)
})

export const SettingsConnection = Schema.Struct({
  provider: Schema.Literal("sendblue"),
  status: Schema.Literals(["connected", "not_connected", "paused", "unavailable"])
})

export const OwnerSettingsView = Schema.Struct({
  settings: OwnerSettings,
  connections: Schema.Array(SettingsConnection)
})

export type HourCycle = typeof HourCycle.Type
export type OwnerSettings = typeof OwnerSettings.Type
export type OwnerSettingsUpdate = typeof OwnerSettingsUpdate.Type
export type SettingsConnection = typeof SettingsConnection.Type
export type OwnerSettingsView = typeof OwnerSettingsView.Type
