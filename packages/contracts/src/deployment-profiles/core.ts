import { makeCapabilityCatalogue } from "../capabilities/catalogue.ts"
import { memoryCapability } from "../capabilities/memory.ts"
import { settingsCapability } from "../capabilities/settings.ts"

export const coreDeploymentProfile = makeCapabilityCatalogue("core", [
  memoryCapability,
  settingsCapability
])
