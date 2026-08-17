import type {
  CoreDeploymentProfile,
  DeploymentProfileContext,
  PreparedDeploymentProfile,
  VerticalModule
} from "@bob/deployment-profile-types/runtime"
import type { CapabilityCatalogue } from "@bob/tools-types/tools"

import { connectionsVerticalModule } from "@bob/connections-service/vertical-module"
import { makeRuntimeModules } from "@bob/core-types/runtime-module"
import {
  coreDeploymentProfile,
  transitionalDeploymentProfile
} from "@bob/deployment-profile-types/profiles"
import { journalVerticalModule } from "@bob/journal-service/vertical-module"
import { reminderVerticalModule } from "@bob/reminders-service/vertical-module"
import { trainingVerticalModule } from "@bob/training-service/vertical-module"

function prepareVerticalModules(
  verticalModules: readonly VerticalModule[],
  context: DeploymentProfileContext
): PreparedDeploymentProfile {
  const prepared = verticalModules.map((module) => {
    const contribution = module.prepare(context)
    if (contribution.id !== module.id || contribution.capability.id !== module.capability.id) {
      throw new Error(`Prepared Vertical Module does not match ${module.id}`)
    }
    return contribution
  })

  return Object.freeze({
    verticalModules: Object.freeze(prepared),
    evidenceSources: Object.freeze(prepared.flatMap((module) => module.evidenceSources)),
    legacyArtifactReaders: Object.freeze(
      prepared.flatMap((module) => module.legacyArtifactReaders)
    ),
    deliveryTargets: Object.freeze(prepared.flatMap((module) => module.deliveryTargets)),
    runtimeModules: makeRuntimeModules({
      conversations: prepared.flatMap((module) => module.runtimeModules.conversations),
      ownerRoutes: prepared.flatMap((module) => module.runtimeModules.ownerRoutes),
      scheduledTasks: prepared.flatMap((module) => module.runtimeModules.scheduledTasks)
    }),
    toolAdapters: Object.freeze(prepared.flatMap((module) => module.toolAdapters))
  })
}

function makeRuntimeProfile(
  catalogue: CapabilityCatalogue,
  selectedVerticalModules: readonly VerticalModule[]
): CoreDeploymentProfile {
  const verticalModules = Object.freeze([...selectedVerticalModules])
  const expectedIds = catalogue.modules
    .map((module) => module.id)
    .filter((id) => id !== "memory" && id !== "settings")
  const selectedIds = verticalModules.map((module) => module.id)
  if (expectedIds.join("\0") !== selectedIds.join("\0")) {
    throw new Error(`Runtime view does not match Deployment Profile ${catalogue.profileId}`)
  }

  return Object.freeze({
    catalogue,
    verticalModules,
    prepare: (context: DeploymentProfileContext) => prepareVerticalModules(verticalModules, context)
  })
}

export const coreRuntimeProfile = makeRuntimeProfile(coreDeploymentProfile, [])

const transitionalVerticalModules = Object.freeze([
  reminderVerticalModule,
  journalVerticalModule,
  trainingVerticalModule,
  connectionsVerticalModule
])

export const transitionalRuntimeProfile = makeRuntimeProfile(
  transitionalDeploymentProfile,
  transitionalVerticalModules
)
