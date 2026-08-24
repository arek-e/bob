import type { PreparedVerticalModule, VerticalModule } from "@bob/deployment-profile-types/runtime"

import { createRuntimeModules } from "@bob/core-types/runtime-module"
import { trainingCapability } from "@bob/training-types/capability"

import { createTrainingConversationWorkflow } from "./conversation-workflow.ts"
import { createTrainingEvidenceSource } from "./evidence-source.ts"
import { legacyTrainingArtifactReader } from "./legacy-artifact.ts"
import { createTrainingModule } from "./module.ts"
import { createTrainingOwnerRoutes } from "./owner-routes.ts"
import { createTrainingProposalStore } from "./proposal-store.ts"
import { createTrainingStore } from "./store.ts"
import { createTrainingToolAdapter } from "./tool-adapter.ts"

export const trainingVerticalModule: VerticalModule = {
  id: trainingCapability.id,
  capability: trainingCapability,
  prepare(context): PreparedVerticalModule {
    const store = createTrainingStore(context.database, {})
    const training = createTrainingModule(
      store,
      createTrainingProposalStore(context.database, context.protection, store, {
        ownerDataKeys: context.ownerDataKeys
      })
    )

    return {
      id: trainingCapability.id,
      capability: trainingCapability,
      evidenceSources: [createTrainingEvidenceSource(context.database, context.protection)],
      legacyArtifactReaders: [legacyTrainingArtifactReader],
      deliveryTargets: [],
      runtimeModules: createRuntimeModules({
        conversations: [createTrainingConversationWorkflow(training)],
        ownerRoutes: [createTrainingOwnerRoutes(training)]
      }),
      toolAdapters: [createTrainingToolAdapter(training)]
    }
  }
}
