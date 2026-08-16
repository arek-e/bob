import { connectionsCapability } from "@bob/connections-types/capability"
import { makeCapabilityCatalogue } from "@bob/core-capabilities-types/catalogue"
import { journalCapability } from "@bob/journal-types/capability"
import { reminderCapability } from "@bob/reminders-types/capability"
import { trainingCapability } from "@bob/training-types/capability"

import { memoryCapability } from "../capabilities/memory.ts"
import { settingsCapability } from "../capabilities/settings.ts"

export const transitionalDeploymentProfile = makeCapabilityCatalogue("transitional", [
  reminderCapability,
  memoryCapability,
  journalCapability,
  trainingCapability,
  settingsCapability,
  connectionsCapability
])
