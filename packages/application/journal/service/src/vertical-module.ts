import type { PreparedVerticalModule, VerticalModule } from "@bob/deployment-profile-types/runtime"

import { createRuntimeModules } from "@bob/core-types/runtime-module"
import { journalCapability } from "@bob/journal-types/capability"
import { Schema } from "effect"

import { createJournalConversationWorkflow } from "./conversation-workflow.ts"
import { createJournalEvidenceSource } from "./evidence-source.ts"
import { createJournalOwnerRoutes } from "./owner-routes.ts"
import { createJournalStore } from "./store.ts"
import { createJournalToolAdapter } from "./tool-adapter.ts"

const Configuration = Schema.Struct({
  UI_BASE_URL: Schema.URLFromString
})

export const journalVerticalModule: VerticalModule = {
  id: journalCapability.id,
  capability: journalCapability,
  prepare(context): PreparedVerticalModule {
    const config = Schema.decodeUnknownSync(Configuration)(context.bindings)
    const uiBaseUrl = config.UI_BASE_URL.toString().replace(/\/$/u, "")
    const journal = createJournalStore(context.database, context.protection, {
      ownerDataKeys: context.ownerDataKeys
    })

    return {
      id: journalCapability.id,
      capability: journalCapability,
      evidenceSources: [createJournalEvidenceSource(context.database, context.protection)],
      legacyArtifactReaders: [],
      deliveryTargets: [],
      runtimeModules: createRuntimeModules({
        conversations: [createJournalConversationWorkflow(journal, context.turns, uiBaseUrl)],
        ownerRoutes: [createJournalOwnerRoutes(journal)]
      }),
      toolAdapters: [createJournalToolAdapter(journal, context.turns, { uiBaseUrl })]
    }
  }
}
