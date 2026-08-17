import { makeCapabilityCatalogue } from "@bob/capabilities-types/catalogue"
import { connectionsCapability } from "@bob/connections-types/capability"
import { journalCapability } from "@bob/journal-types/capability"
import { memoryCapability } from "@bob/memory-types/capability"
import { reminderCapability } from "@bob/reminders-types/capability"
import { settingsCapability } from "@bob/settings-types/capability"
import { trainingCapability } from "@bob/training-types/capability"

export const coreDeploymentProfile = makeCapabilityCatalogue("core", [
  memoryCapability,
  settingsCapability
])

export const transitionalDeploymentProfile = makeCapabilityCatalogue("transitional", [
  reminderCapability,
  memoryCapability,
  journalCapability,
  trainingCapability,
  settingsCapability,
  connectionsCapability
])
