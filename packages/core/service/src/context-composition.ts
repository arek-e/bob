import type { ArtifactStoreAdapter } from "@bob/artifacts-types/store"
import type { CoreDatabase } from "@bob/db-types"
import type { DataProtection } from "@bob/policy-types/data-protection"
import type { OwnerDataKeyStoreAdapter } from "@bob/policy-types/owner-data-key"
import type { RetrievalPipelineAdapter } from "@bob/retrieval-types/retrieval"
import type { CapabilityCatalogue } from "@bob/tools-types/tools"

import { createArtifactContextSource } from "@bob/artifacts-service/context-source"
import { createPrivateTextReader } from "@bob/context-service/private-text"
import { createContextSourceRegistry } from "@bob/context-service/source"
import { createContextStore } from "@bob/context-service/store"
import { createConversationContextSources } from "@bob/conversations-service/context-sources"
import { createPriorToolReceiptSource } from "@bob/conversations-service/prior-tool-receipts"
import { createRetrievalContextSource } from "@bob/retrieval-service/context-source"

export function createApplicationContextStore(
  database: CoreDatabase,
  protection: DataProtection,
  catalogue: CapabilityCatalogue,
  modules: {
    readonly artifacts: ArtifactStoreAdapter
    readonly retrieval: RetrievalPipelineAdapter
    readonly ownerDataKeys: OwnerDataKeyStoreAdapter
  }
) {
  const text = createPrivateTextReader(database, protection, modules.ownerDataKeys)
  const [inlineReply, conversation] = createConversationContextSources(database, text)
  if (inlineReply === undefined || conversation === undefined) {
    throw new Error("The Context source profile is incomplete")
  }
  const registry = createContextSourceRegistry(catalogue.profileId, [
    inlineReply,
    conversation,
    createArtifactContextSource(modules.artifacts),
    createRetrievalContextSource(modules.retrieval)
  ])
  if (registry.profileId !== catalogue.profileId) {
    throw new Error("Capability and Context profiles do not match")
  }
  return createContextStore(registry, createPriorToolReceiptSource(database, text))
}
