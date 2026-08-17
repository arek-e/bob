import type { PreparedVerticalModule, VerticalModule } from "@bob/deployment-profile-types/runtime"

import { makeRuntimeModules } from "@bob/core-types/runtime-module"
import { journalCapability } from "@bob/journal-types/capability"
import { Schema } from "effect"

import { makeJournalConversationWorkflow } from "./conversation-workflow.ts"
import { makeJournalEvidenceSource } from "./evidence-source.ts"
import { makeJournalOwnerRoutes } from "./owner-routes.ts"
import { makeJournalStore } from "./store.ts"
import { makeJournalToolAdapter } from "./tool-adapter.ts"

const Configuration = Schema.Struct({
  UI_BASE_URL: Schema.URLFromString
})

export const journalVerticalModule: VerticalModule = {
  id: journalCapability.id,
  capability: journalCapability,
  prepare(context): PreparedVerticalModule {
    const config = Schema.decodeUnknownSync(Configuration)(context.bindings)
    const uiBaseUrl = config.UI_BASE_URL.toString().replace(/\/$/u, "")
    const journal = makeJournalStore(context.database, context.protection, {
      ownerDataKeys: context.ownerDataKeys
    })

    return {
      id: journalCapability.id,
      capability: journalCapability,
      evidenceSources: [makeJournalEvidenceSource(context.database, context.protection)],
      legacyArtifactReaders: [],
      deliveryTargets: [],
      runtimeModules: makeRuntimeModules({
        conversations: [makeJournalConversationWorkflow(journal, context.turns, uiBaseUrl)],
        ownerRoutes: [makeJournalOwnerRoutes(journal)]
      }),
      toolAdapters: [makeJournalToolAdapter(journal, context.turns, { uiBaseUrl })]
    }
  }
}
