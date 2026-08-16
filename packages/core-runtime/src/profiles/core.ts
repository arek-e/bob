import { coreDeploymentProfile } from "@bob/contracts/deployment-profiles/core"

import type { DeploymentRuntimeProfile } from "./types.ts"

import { makeRuntimeModules } from "../modules/runtime/module.ts"

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
