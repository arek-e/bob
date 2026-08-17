import type { CoreDeploymentProfile } from "@bob/core-service/deployment-profile"

import { coreDeploymentProfile } from "@bob/core-types/profiles"
import { makeRuntimeModules } from "@bob/core-types/runtime-module"

export const coreRuntimeProfile: CoreDeploymentProfile = {
  catalogue: coreDeploymentProfile,
  prepare() {
    return {
      evidenceSources: [],
      legacyArtifactReaders: [],
      deliveryTargets: [],
      modules: makeRuntimeModules({}),
      extensions: {},
      toolAdapters: () => []
    }
  }
}
