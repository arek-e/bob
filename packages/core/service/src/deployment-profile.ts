import type { LegacyArtifactReader } from "@bob/artifacts-service/store"
import type { CapabilityCatalogue } from "@bob/capabilities-types/tools"
import type { ConversationStoreAdapter } from "@bob/conversations-types/store"
import type { ToolCommandAdapter } from "@bob/conversations-types/tool-adapter"
import type { ConversationTurnStoreAdapter } from "@bob/conversations-types/turn-store"
import type { GeneralCoreBindings } from "@bob/core-types/bindings"
import type { RuntimeModules } from "@bob/core-types/runtime-module"
import type { CoreDatabase } from "@bob/db-types"
import type { DeliveryTargetAdapter } from "@bob/delivery-service/target-adapter"
import type { EvidenceSourceAdapter } from "@bob/memory-types/evidence"
import type { MemoryStoreAdapter } from "@bob/memory-types/store"
import type { DataProtection } from "@bob/policy-types/data-protection"
import type { OwnerDataKeyStoreAdapter } from "@bob/policy-types/owner-data-key"
import type { RetrievalPipelineAdapter } from "@bob/retrieval-types/retrieval"
import type { OwnerSettingsStoreAdapter } from "@bob/settings-types/store"

export interface DeploymentProfileContext {
  readonly bindings: GeneralCoreBindings
  readonly database: CoreDatabase
  readonly protection: DataProtection
  readonly ownerDataKeys: OwnerDataKeyStoreAdapter
  readonly conversations: ConversationStoreAdapter
  readonly turns: ConversationTurnStoreAdapter
  readonly settings: OwnerSettingsStoreAdapter
  readonly ownerId: string
  readonly ownerTimeZone: string
}

export interface DeploymentProfileToolsContext {
  readonly memory: MemoryStoreAdapter
  readonly retrieval: RetrievalPipelineAdapter
}

export interface PreparedDeploymentProfile<Extensions extends object = object> {
  readonly evidenceSources: readonly EvidenceSourceAdapter[]
  readonly legacyArtifactReaders: readonly LegacyArtifactReader[]
  readonly deliveryTargets: readonly DeliveryTargetAdapter[]
  readonly modules: RuntimeModules
  readonly extensions: Extensions
  toolAdapters(context: DeploymentProfileToolsContext): readonly ToolCommandAdapter[]
}

export interface CoreDeploymentProfile<Extensions extends object = object> {
  readonly catalogue: CapabilityCatalogue
  prepare(context: DeploymentProfileContext): PreparedDeploymentProfile<Extensions>
}
