import { connectionsCapability } from "@bob/connections-types/capability"
import { journalCapability } from "@bob/journal-types/capability"
import { memoryCapability } from "@bob/memory-types/capability"
import { reminderCapability } from "@bob/reminders-types/capability"
import { settingsCapability } from "@bob/settings-types/capability"
import { createCapabilityCatalogue } from "@bob/tools-types/catalogue"
import { trainingCapability } from "@bob/training-types/capability"

export const coreDeploymentProfile = createCapabilityCatalogue("core", [
  memoryCapability,
  settingsCapability
])

export const transitionalDeploymentProfile = createCapabilityCatalogue("transitional", [
  reminderCapability,
  memoryCapability,
  journalCapability,
  trainingCapability,
  settingsCapability,
  connectionsCapability
])
