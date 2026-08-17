import type { PreparedVerticalModule, VerticalModule } from "@bob/deployment-profile-types/runtime"

import { makeRuntimeModules } from "@bob/core-types/runtime-module"
import { trainingCapability } from "@bob/training-types/capability"

import { makeTrainingConversationWorkflow } from "./conversation-workflow.ts"
import { makeTrainingEvidenceSource } from "./evidence-source.ts"
import { legacyTrainingArtifactReader } from "./legacy-artifact.ts"
import { makeTrainingModule } from "./module.ts"
import { makeTrainingOwnerRoutes } from "./owner-routes.ts"
import { makeTrainingProposalStore } from "./proposal-store.ts"
import { makeTrainingStore } from "./store.ts"
import { makeTrainingToolAdapter } from "./tool-adapter.ts"

export const trainingVerticalModule: VerticalModule = {
  id: trainingCapability.id,
  capability: trainingCapability,
  prepare(context): PreparedVerticalModule {
    const store = makeTrainingStore(context.database, {})
    const training = makeTrainingModule(
      store,
      makeTrainingProposalStore(context.database, context.protection, store, {
        ownerDataKeys: context.ownerDataKeys
      })
    )

    return {
      id: trainingCapability.id,
      capability: trainingCapability,
      evidenceSources: [makeTrainingEvidenceSource(context.database, context.protection)],
      legacyArtifactReaders: [legacyTrainingArtifactReader],
      deliveryTargets: [],
      runtimeModules: makeRuntimeModules({
        conversations: [makeTrainingConversationWorkflow(training)],
        ownerRoutes: [makeTrainingOwnerRoutes(training)]
      }),
      toolAdapters: [makeTrainingToolAdapter(training)]
    }
  }
}
