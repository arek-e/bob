import type { CoreAdapters } from "@bob/core-types/adapters"
import type { GeneralCoreBindings } from "@bob/core-types/bindings"

import { artifactStoreLayer, makeArtifactStore } from "@bob/artifacts-service/store"
import { makePrivateTextReader } from "@bob/context-service/private-text"
import { contextStoreLayer } from "@bob/context-service/store"
import { makeConversationEvidenceSource } from "@bob/conversations-service/evidence-source"
import { agentRunStoreLayer, makeAgentRunStore } from "@bob/conversations-service/run-store"
import { conversationStoreLayer, makeConversationStore } from "@bob/conversations-service/store"
import { conversationTiming } from "@bob/conversations-service/timing"
import { makeToolExecutor, toolExecutorLayer } from "@bob/conversations-service/tool-executor"
import {
  conversationTurnStoreLayer,
  makeConversationTurnStore
} from "@bob/conversations-service/turn-store"
import { deliveryStoreLayer, makeDeliveryStore } from "@bob/delivery-service/store"
import { makeAgentExperienceRegistry } from "@bob/memory-service/agent-experience"
import { makeEvidenceSourceRegistry } from "@bob/memory-service/evidence"
import { makeFactEvidenceSource } from "@bob/memory-service/evidence-source"
import { makeMemoryStore, memoryStoreLayer } from "@bob/memory-service/store"
import { makeMemoryToolAdapter } from "@bob/memory-service/tool-adapter"
import { alertStoreLayer, makeAlertStore } from "@bob/operations-service/alerts/store"
import { createDataProtection } from "@bob/policy-service/data-protection"
import { makeOwnerDataKeyStore, ownerDataKeyStoreLayer } from "@bob/policy-service/owner-data-key"
import { makeRetrievalPipeline, retrievalPipelineLayer } from "@bob/retrieval-service/pipeline"
import { makeOwnerSettingsStore, ownerSettingsStoreLayer } from "@bob/settings-service/store"
import { makeSettingsToolAdapter } from "@bob/settings-service/tool-adapter"
import { makeReviewedSkillRegistry } from "@bob/skills-service/registry"
import { makeToolAdapterRegistry } from "@bob/tools-service/registry"
import { Layer, Schema } from "effect"

import type { CoreDeploymentProfile } from "./deployment-profile.ts"

import { makeApplicationContextStore } from "./context-composition.ts"

const Configuration = Schema.Struct({
  OWNER_ID: Schema.String.check(Schema.isUUID()),
  OWNER_TIME_ZONE: Schema.String,
  DATA_KEK_ACTIVE_VERSION: Schema.String,
  DATA_KEK_KEYRING_JSON: Schema.String.check(Schema.isMinLength(1)),
  DATA_LOOKUP_KEY: Schema.String.check(Schema.isMinLength(40)),
  INGRESS_CALLER_SECRET: Schema.String.check(Schema.isMinLength(32)),
  EGRESS_CALLER_SECRET: Schema.String.check(Schema.isMinLength(32)),
  CHANNEL_EGRESS_URL: Schema.String,
  BETTER_AUTH_SECRET: Schema.String.check(Schema.isMinLength(32)),
  SETUP_TOKEN: Schema.String.check(Schema.isMinLength(32)),
  OWNER_ACCESS_EMAIL: Schema.String.check(Schema.isMinLength(3)),
  AGENT_CALLER_SECRET: Schema.String.check(Schema.isMinLength(32)),
  AGENT_URL: Schema.String,
  AGENT_ADMIN_URL: Schema.String,
  BOB_MODEL: Schema.String,
  BOB_PROVIDER: Schema.Literal("openai-codex"),
  BOB_RUN_TOKEN_BUDGET: Schema.Number.check(
    Schema.isInt(),
    Schema.isBetween({ minimum: 1_000, maximum: 1_000_000 })
  ),
  BOB_DAILY_TOKEN_BUDGET: Schema.Number.check(
    Schema.isInt(),
    Schema.isBetween({ minimum: 1_000, maximum: 10_000_000 })
  )
})

export function composeGeneralCore<Extensions extends object>(
  bindings: GeneralCoreBindings,
  runtimeProfile: CoreDeploymentProfile<Extensions>,
  adapters: CoreAdapters
) {
  const config = Schema.decodeUnknownSync(Configuration)(bindings)
  const { applicationStorage, channelProviderId } = adapters
  const activeKekVersion = Number.parseInt(config.DATA_KEK_ACTIVE_VERSION, 10)
  const keyringInput = Schema.decodeUnknownSync(
    Schema.Record(Schema.String, Schema.String.check(Schema.isMinLength(40)))
  )(JSON.parse(config.DATA_KEK_KEYRING_JSON))
  const keyring = Object.fromEntries(
    Object.entries(keyringInput).map(([version, value]) => {
      const parsed = Number.parseInt(version, 10)
      if (!Number.isInteger(parsed) || parsed < 1) throw new Error("Invalid KEK version")
      return [parsed, value]
    })
  )
  if (keyring[activeKekVersion] === undefined) throw new Error("Active KEK is missing")
  const protection = createDataProtection(keyring, activeKekVersion, config.DATA_LOOKUP_KEY)
  const ownerDataKeys = makeOwnerDataKeyStore(applicationStorage, protection, {
    defaultTimeZone: config.OWNER_TIME_ZONE
  })
  const settings = makeOwnerSettingsStore(applicationStorage, protection, {
    defaultTimeZone: config.OWNER_TIME_ZONE,
    ownerDataKeys,
    channelProviderId
  })
  const conversations = makeConversationStore(applicationStorage, protection, {
    ownerId: config.OWNER_ID,
    ownerTimeZone: config.OWNER_TIME_ZONE,
    ownerDataKeys,
    channelProviderId
  })
  const turns = makeConversationTurnStore(applicationStorage, protection, {
    ownerId: config.OWNER_ID,
    ownerDataKeys
  })
  const prepared = runtimeProfile.prepare({
    bindings,
    database: applicationStorage,
    protection,
    ownerDataKeys,
    conversations,
    turns,
    settings,
    ownerId: config.OWNER_ID,
    ownerTimeZone: config.OWNER_TIME_ZONE
  })
  const alerts = makeAlertStore(applicationStorage, {})
  const artifacts = makeArtifactStore(applicationStorage, protection, {
    legacyReaders: prepared.legacyArtifactReaders,
    ownerDataKeys
  })
  const delivery = makeDeliveryStore(applicationStorage, protection, {
    channelProviderId,
    targetAdapters: prepared.deliveryTargets,
    ownerDataKeys
  })
  const privateText = makePrivateTextReader(applicationStorage, protection, ownerDataKeys)
  const evidenceSources = makeEvidenceSourceRegistry(runtimeProfile.catalogue.profileId, [
    makeConversationEvidenceSource(applicationStorage, privateText, protection),
    makeFactEvidenceSource(applicationStorage, privateText, protection),
    ...prepared.evidenceSources
  ])
  const memory = makeMemoryStore(applicationStorage, protection, evidenceSources, {
    ownerDataKeys
  })
  const retrieval = makeRetrievalPipeline(applicationStorage)
  const context = makeApplicationContextStore(
    applicationStorage,
    protection,
    runtimeProfile.catalogue,
    {
      artifacts,
      retrieval,
      ownerDataKeys
    }
  )
  const runs = makeAgentRunStore(applicationStorage, protection, { ownerDataKeys })
  const toolAdapters = makeToolAdapterRegistry(runtimeProfile.catalogue, [
    makeMemoryToolAdapter(memory, retrieval),
    makeSettingsToolAdapter(settings),
    ...prepared.toolAdapters({ memory, retrieval })
  ])
  const tools = makeToolExecutor(applicationStorage, protection, toolAdapters, {
    toolLeaseMs: conversationTiming.mutationSettleLeaseMs,
    ownerDataKeys
  })
  const agentExperience = makeAgentExperienceRegistry(runtimeProfile.catalogue.profileId, [])
  const reviewedSkills = makeReviewedSkillRegistry(runtimeProfile.catalogue.profileId, [])
  const layer = Layer.mergeAll(
    conversationStoreLayer(conversations),
    conversationTurnStoreLayer(turns),
    ownerDataKeyStoreLayer(ownerDataKeys),
    alertStoreLayer(alerts),
    artifactStoreLayer(artifacts),
    deliveryStoreLayer(delivery),
    memoryStoreLayer(memory),
    retrievalPipelineLayer(retrieval),
    ownerSettingsStoreLayer(settings),
    contextStoreLayer(context),
    agentRunStoreLayer(runs),
    toolExecutorLayer(tools)
  )
  return {
    config,
    profile: runtimeProfile.catalogue,
    modules: prepared.modules,
    layer,
    extensions: prepared.extensions,
    memoryClasses: Object.freeze({ agentExperience, reviewedSkills }),
    jobQueue: adapters.jobQueue,
    objectStorage: adapters.objectStorage,
    runCoordinator: adapters.runCoordinator,
    applicationStorage
  }
}
