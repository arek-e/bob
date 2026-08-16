import type { CapabilityCatalogue } from "@bob/core-capabilities-types/tools"
import type { CoreDatabase } from "@bob/core-types/database"

import type { ArtifactStore } from "../artifacts/store.ts"
import type { DataProtection } from "../policy/data-protection.ts"
import type { OwnerDataKeyStore } from "../policy/owner-data-key.ts"
import type { RetrievalPipeline } from "../retrieval/pipeline.ts"

import { makeArtifactContextSource } from "../artifacts/context-source.ts"
import { makeConversationContextSources } from "../conversations/context-sources.ts"
import { makePriorToolReceiptSource } from "../conversations/prior-tool-receipts.ts"
import { makeRetrievalContextSource } from "../retrieval/context-source.ts"
import { makePrivateTextReader } from "./private-text.ts"
import { makeContextSourceRegistry } from "./source.ts"
import { makeContextStore } from "./store.ts"

export function makeApplicationContextStore(
  database: CoreDatabase,
  protection: DataProtection,
  catalogue: CapabilityCatalogue,
  modules: {
    readonly artifacts: ArtifactStore
    readonly retrieval: RetrievalPipeline
    readonly ownerDataKeys: OwnerDataKeyStore
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
