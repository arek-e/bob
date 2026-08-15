import type { CapabilityCatalogue } from "@bob/contracts/tools"

import type { CoreDatabase } from "../../database.ts"
import type { ArtifactStore } from "../artifacts/store.ts"
import type { MemoryStore } from "../memory/store.ts"
import type { DataProtection } from "../policy/data-protection.ts"

import { makeArtifactContextSource } from "../artifacts/context-source.ts"
import { makeConversationContextSources } from "../conversations/context-sources.ts"
import { makePriorToolReceiptSource } from "../conversations/prior-tool-receipts.ts"
import { makeMemoryContextSources } from "../memory/context-sources.ts"
import { makePrivateTextReader } from "./private-text.ts"
import { makeContextSourceRegistry } from "./source.ts"
import { makeContextStore } from "./store.ts"

export function makeApplicationContextStore(
  database: CoreDatabase,
  protection: DataProtection,
  catalogue: CapabilityCatalogue,
  modules: { readonly artifacts: ArtifactStore; readonly memory: MemoryStore }
) {
  const text = makePrivateTextReader(database, protection)
  const [inlineReply, conversation] = makeConversationContextSources(database, text)
  const [profile, lexical] = makeMemoryContextSources(database, modules.memory, text)
  if (
    inlineReply === undefined ||
    profile === undefined ||
    conversation === undefined ||
    lexical === undefined
  ) {
    throw new Error("The Context source profile is incomplete")
  }
  const registry = makeContextSourceRegistry(catalogue.profileId, [
    inlineReply,
    profile,
    conversation,
    makeArtifactContextSource(modules.artifacts),
    lexical
  ])
  if (registry.profileId !== catalogue.profileId) {
    throw new Error("Capability and Context profiles do not match")
  }
  return makeContextStore(registry, makePriorToolReceiptSource(database, text))
}
