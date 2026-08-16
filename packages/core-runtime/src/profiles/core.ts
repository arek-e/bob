import { coreDeploymentProfile } from "@bob/core-types/profiles/core"
import { makeRuntimeModules } from "@bob/core-types/runtime-module"

import type { DeploymentRuntimeProfile } from "./types.ts"

export const coreRuntimeProfile: DeploymentRuntimeProfile = {
  catalogue: coreDeploymentProfile,
  prepare() {
    return {
      evidenceSources: [],
      legacyArtifactReaders: [],
      deliveryTargets: [],
      runtime: makeRuntimeModules({}),
      extensions: {},
      toolAdapters: () => []
    }
  }
}
