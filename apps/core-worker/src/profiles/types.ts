import type { CapabilityCatalogue } from "@bob/contracts/tools"

import type { GeneralCoreBindings } from "../bindings.ts"
import type { CoreDatabase } from "../database.ts"
import type { LegacyArtifactReader } from "../modules/artifacts/store.ts"
import type { ConversationStore } from "../modules/conversations/store.ts"
import type { ToolCommandAdapter } from "../modules/conversations/tool-adapter.ts"
import type { ConversationTurnStore } from "../modules/conversations/turn-store.ts"
import type { DeliveryTargetAdapter } from "../modules/delivery/target-adapter.ts"
import type { EvidenceSourceAdapter } from "../modules/memory/evidence.ts"
import type { MemoryStore } from "../modules/memory/store.ts"
import type { DataProtection } from "../modules/policy/data-protection.ts"
import type { RetrievalPipeline } from "../modules/retrieval/pipeline.ts"
import type { RuntimeModules } from "../modules/runtime/module.ts"
import type { OwnerSettingsStore } from "../modules/settings/store.ts"

export interface RuntimeProfileContext {
  readonly bindings: GeneralCoreBindings
  readonly database: CoreDatabase
  readonly protection: DataProtection
  readonly conversations: ConversationStore
  readonly turns: ConversationTurnStore
  readonly settings: OwnerSettingsStore
  readonly ownerId: string
  readonly ownerTimeZone: string
}

export interface RuntimeProfileToolsContext {
  readonly memory: MemoryStore
  readonly retrieval: RetrievalPipeline
}

export interface PreparedRuntimeProfile<Extensions extends object = object> {
  readonly evidenceSources: readonly EvidenceSourceAdapter[]
  readonly legacyArtifactReaders: readonly LegacyArtifactReader[]
  readonly deliveryTargets: readonly DeliveryTargetAdapter[]
  readonly runtime: RuntimeModules
  readonly extensions: Extensions
  toolAdapters(context: RuntimeProfileToolsContext): readonly ToolCommandAdapter[]
}

export interface DeploymentRuntimeProfile<Extensions extends object = object> {
  readonly catalogue: CapabilityCatalogue
  prepare(context: RuntimeProfileContext): PreparedRuntimeProfile<Extensions>
}
