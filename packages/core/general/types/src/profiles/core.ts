import { makeCapabilityCatalogue } from "@bob/core-capabilities-types/catalogue"

import { memoryCapability } from "../capabilities/memory.ts"
import { settingsCapability } from "../capabilities/settings.ts"

export const coreDeploymentProfile = makeCapabilityCatalogue("core", [
  memoryCapability,
  settingsCapability
])
