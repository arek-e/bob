import type { CapabilityCatalogue } from "@bob/core-capabilities-types/tools"
import type { LegacyArtifactReader } from "@bob/core-service/artifacts/store"
import type { ConversationStore } from "@bob/core-service/conversations/store"
import type { ToolCommandAdapter } from "@bob/core-service/conversations/tool-adapter"
import type { ConversationTurnStore } from "@bob/core-service/conversations/turn-store"
import type { DeliveryTargetAdapter } from "@bob/core-service/delivery/target-adapter"
import type { EvidenceSourceAdapter } from "@bob/core-service/memory/evidence"
import type { MemoryStore } from "@bob/core-service/memory/store"
import type { DataProtection } from "@bob/core-service/policy/data-protection"
import type { OwnerDataKeyStore } from "@bob/core-service/policy/owner-data-key"
import type { RetrievalPipeline } from "@bob/core-service/retrieval/pipeline"
import type { OwnerSettingsStore } from "@bob/core-service/settings/store"
import type { GeneralCoreBindings } from "@bob/core-types/bindings"
import type { CoreDatabase } from "@bob/core-types/database"
import type { RuntimeModules } from "@bob/core-types/runtime-module"

export interface RuntimeProfileContext {
  readonly bindings: GeneralCoreBindings
  readonly database: CoreDatabase
  readonly protection: DataProtection
  readonly ownerDataKeys: OwnerDataKeyStore
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
