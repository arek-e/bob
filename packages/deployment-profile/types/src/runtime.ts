import type { LegacyArtifactReader } from "@bob/artifacts-types/store"
import type { ConversationStoreAdapter } from "@bob/conversations-types/store"
import type { ConversationTurnStoreAdapter } from "@bob/conversations-types/turn-store"
import type { RuntimeModules } from "@bob/core-types/runtime-module"
import type { CoreDatabase } from "@bob/db-types"
import type { DeliveryTargetAdapter } from "@bob/delivery-types/target"
import type { EvidenceSourceAdapter } from "@bob/memory-types/evidence"
import type { DataProtection } from "@bob/policy-types/data-protection"
import type { OwnerDataKeyStoreAdapter } from "@bob/policy-types/owner-data-key"
import type { OwnerSettingsStoreAdapter } from "@bob/settings-types/store"
import type { ToolCommandAdapter } from "@bob/tools-types/adapter"
import type { CapabilityCatalogue, CapabilityModule } from "@bob/tools-types/tools"

export interface DeploymentProfileContext {
  readonly bindings: unknown
  readonly database: CoreDatabase
  readonly protection: DataProtection
  readonly ownerDataKeys: OwnerDataKeyStoreAdapter
  readonly conversations: ConversationStoreAdapter
  readonly turns: ConversationTurnStoreAdapter
  readonly settings: OwnerSettingsStoreAdapter
  readonly ownerId: string
  readonly ownerTimeZone: string
}

export interface PreparedVerticalModule {
  readonly id: string
  readonly capability: CapabilityModule
  readonly evidenceSources: readonly EvidenceSourceAdapter[]
  readonly legacyArtifactReaders: readonly LegacyArtifactReader[]
  readonly deliveryTargets: readonly DeliveryTargetAdapter[]
  readonly runtimeModules: RuntimeModules
  readonly toolAdapters: readonly ToolCommandAdapter[]
}

export interface VerticalModule {
  readonly id: string
  readonly capability: CapabilityModule
  prepare(context: DeploymentProfileContext): PreparedVerticalModule
}

export interface PreparedDeploymentProfile {
  readonly verticalModules: readonly PreparedVerticalModule[]
  readonly evidenceSources: readonly EvidenceSourceAdapter[]
  readonly legacyArtifactReaders: readonly LegacyArtifactReader[]
  readonly deliveryTargets: readonly DeliveryTargetAdapter[]
  readonly runtimeModules: RuntimeModules
  readonly toolAdapters: readonly ToolCommandAdapter[]
}

export interface CoreDeploymentProfile {
  readonly catalogue: CapabilityCatalogue
  readonly verticalModules: readonly VerticalModule[]
  prepare(context: DeploymentProfileContext): PreparedDeploymentProfile
}
