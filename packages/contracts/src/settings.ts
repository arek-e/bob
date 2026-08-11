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
  provider: Schema.Literals(["sendblue", "openai_codex", "google_calendar", "microsoft_calendar"]),
  status: Schema.Literals(["connected", "not_connected", "paused", "stale", "unavailable"]),
  accountIdRedacted: Schema.optionalKey(Schema.String),
  expiresAt: Schema.optionalKey(IsoDateTime)
})

export const ConnectionProvider = Schema.Literals(["google_calendar", "microsoft_calendar"])

export const ConnectionSession = Schema.Struct({
  provider: ConnectionProvider,
  connectUrl: Schema.String,
  expiresAt: IsoDateTime
})

export const OwnerSettingsView = Schema.Struct({
  settings: OwnerSettings
})

export const AccountConnectionsView = Schema.Struct({
  connections: Schema.Array(SettingsConnection)
})

export type HourCycle = typeof HourCycle.Type
export type OwnerSettings = typeof OwnerSettings.Type
export type OwnerSettingsUpdate = typeof OwnerSettingsUpdate.Type
export type SettingsConnection = typeof SettingsConnection.Type
export type OwnerSettingsView = typeof OwnerSettingsView.Type
export type AccountConnectionsView = typeof AccountConnectionsView.Type
export type ConnectionProvider = typeof ConnectionProvider.Type
export type ConnectionSession = typeof ConnectionSession.Type
