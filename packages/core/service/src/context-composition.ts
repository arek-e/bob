import type { ArtifactStoreAdapter } from "@bob/artifacts-types/store"
import type { CapabilityCatalogue } from "@bob/capabilities-types/tools"
import type { CoreDatabase } from "@bob/db-types"
import type { DataProtection } from "@bob/policy-types/data-protection"
import type { OwnerDataKeyStoreAdapter } from "@bob/policy-types/owner-data-key"
import type { RetrievalPipelineAdapter } from "@bob/retrieval-types/retrieval"

import { makeArtifactContextSource } from "@bob/artifacts-service/context-source"
import { makePrivateTextReader } from "@bob/context-service/private-text"
import { makeContextSourceRegistry } from "@bob/context-service/source"
import { makeContextStore } from "@bob/context-service/store"
import { makeConversationContextSources } from "@bob/conversations-service/context-sources"
import { makePriorToolReceiptSource } from "@bob/conversations-service/prior-tool-receipts"
import { makeRetrievalContextSource } from "@bob/retrieval-service/context-source"

export function makeApplicationContextStore(
  database: CoreDatabase,
  protection: DataProtection,
  catalogue: CapabilityCatalogue,
  modules: {
    readonly artifacts: ArtifactStoreAdapter
    readonly retrieval: RetrievalPipelineAdapter
    readonly ownerDataKeys: OwnerDataKeyStoreAdapter
  }
) {
  const text = makePrivateTextReader(database, protection, modules.ownerDataKeys)
  const [inlineReply, conversation] = makeConversationContextSources(database, text)
  if (inlineReply === undefined || conversation === undefined) {
    throw new Error("The Context source profile is incomplete")
  }
  const registry = makeContextSourceRegistry(catalogue.profileId, [
    inlineReply,
    conversation,
    makeArtifactContextSource(modules.artifacts),
    makeRetrievalContextSource(modules.retrieval)
  ])
  if (registry.profileId !== catalogue.profileId) {
    throw new Error("Capability and Context profiles do not match")
  }
  return makeContextStore(registry, makePriorToolReceiptSource(database, text))
}
