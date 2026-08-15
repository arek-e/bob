import { makeCapabilityCatalogue } from "./capabilities/catalogue.ts"
import { connectionsCapability } from "./capabilities/connections.ts"
import { journalCapability } from "./capabilities/journal.ts"
import { memoryCapability } from "./capabilities/memory.ts"
import { reminderCapability } from "./capabilities/reminders.ts"
import { settingsCapability } from "./capabilities/settings.ts"
import { trainingCapability } from "./capabilities/training.ts"

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
