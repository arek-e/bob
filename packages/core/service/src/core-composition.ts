import type { CoreAdapters } from "@bob/core-types/adapters"
import type { GeneralCoreBindings } from "@bob/core-types/bindings"
import type { CoreDeploymentProfile } from "@bob/deployment-profile-types/runtime"

import {
  agentRunGatewayLayer,
  agentRunsLayer,
  createAgentRunGateway,
  createAgentRuns
} from "@bob/agent-runs-service"
import { artifactStoreLayer, createArtifactStore } from "@bob/artifacts-service/store"
import { createPrivateTextReader } from "@bob/context-service/private-text"
import { contextStoreLayer } from "@bob/context-service/store"
import { messageAttachmentStoreLayer } from "@bob/conversations-service/attachment-store"
import { createConversationEvidenceSource } from "@bob/conversations-service/evidence-source"
import { agentRunStoreLayer, createAgentRunStore } from "@bob/conversations-service/run-store"
import { conversationStoreLayer, createConversationStore } from "@bob/conversations-service/store"
import { conversationTiming } from "@bob/conversations-service/timing"
import { createToolExecutor, toolExecutorLayer } from "@bob/conversations-service/tool-executor"
import {
  conversationTurnStoreLayer,
  createConversationTurnStore
} from "@bob/conversations-service/turn-store"
import { deliveryStoreLayer, createDeliveryStore } from "@bob/delivery-service/store"
import { createAgentExperienceRegistry } from "@bob/memory-service/agent-experience"
import { createEvidenceSourceRegistry } from "@bob/memory-service/evidence"
import { createFactEvidenceSource } from "@bob/memory-service/evidence-source"
import { createMemoryStore, memoryStoreLayer } from "@bob/memory-service/store"
import { createMemoryToolAdapter } from "@bob/memory-service/tool-adapter"
import { alertStoreLayer, createAlertStore } from "@bob/operations-service/alerts/store"
import {
  createProductionDataInspector,
  productionDataInspectorLayer
} from "@bob/operations-service/production-data/inspector"
import { createDataProtection } from "@bob/policy-service/data-protection"
import { createOwnerDataKeyStore, ownerDataKeyStoreLayer } from "@bob/policy-service/owner-data-key"
import { createRetrievalPipeline, retrievalPipelineLayer } from "@bob/retrieval-service/pipeline"
import { createOwnerSettingsStore, ownerSettingsStoreLayer } from "@bob/settings-service/store"
import { createSettingsToolAdapter } from "@bob/settings-service/tool-adapter"
import { createReviewedSkillRegistry } from "@bob/skills-service/registry"
import { createToolAdapterRegistry } from "@bob/tools-service/registry"
import { Layer, Schema } from "effect"

import { createApplicationContextStore } from "./context-composition.ts"

const Configuration = Schema.Struct({
  OWNER_ID: Schema.optionalKey(Schema.String.check(Schema.isUUID())),
  OWNER_TIME_ZONE: Schema.String,
  DATA_KEK_ACTIVE_VERSION: Schema.String,
  DATA_KEK_KEYRING_JSON: Schema.String.check(Schema.isMinLength(1)),
  DATA_LOOKUP_KEY: Schema.String.check(Schema.isMinLength(40)),
  INGRESS_CALLER_SECRET: Schema.String.check(Schema.isMinLength(32)),
  EGRESS_CALLER_SECRET: Schema.String.check(Schema.isMinLength(32)),
  PRODUCTION_DATA_INSPECTOR_SECRET: Schema.String.check(Schema.isMinLength(32)),
  BOB_HEADLESS_API_KEY: Schema.String.check(Schema.isMinLength(32)),
  BOB_HEADLESS_OWNER_ID: Schema.optionalKey(Schema.String.check(Schema.isUUID())),
  CHANNEL_EGRESS_URL: Schema.String,
  BETTER_AUTH_SECRET: Schema.String.check(Schema.isMinLength(32)),
  SETUP_TOKEN: Schema.String.check(Schema.isMinLength(32)),
  OWNER_ACCESS_EMAIL: Schema.optionalKey(Schema.String.check(Schema.isMinLength(3))),
  AGENT_CALLER_SECRET: Schema.String.check(Schema.isMinLength(32)),
  AGENT_URL: Schema.String,
  AGENT_ADMIN_URL: Schema.String,
  AGENT_EXECUTION_POOL_ID: Schema.optionalKey(Schema.String.check(Schema.isMinLength(1))),
  ASYNC_AGENT_RUNS: Schema.optionalKey(Schema.Literal("true")),
  BOB_MODEL: Schema.String,
  BOB_PROVIDER: Schema.String,
  BOB_RUN_TOKEN_BUDGET: Schema.Number.check(
    Schema.isInt(),
    Schema.isBetween({ minimum: 1_000, maximum: 1_000_000 })
  ),
  BOB_DAILY_TOKEN_BUDGET: Schema.Number.check(
    Schema.isInt(),
    Schema.isBetween({ minimum: 1_000, maximum: 10_000_000 })
  )
})

export function composeGeneralCore(
  bindings: GeneralCoreBindings,
  runtimeProfile: CoreDeploymentProfile,
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
  const ownerDataKeys = createOwnerDataKeyStore(applicationStorage, protection, {
    defaultTimeZone: config.OWNER_TIME_ZONE
  })
  const settings = createOwnerSettingsStore(applicationStorage, protection, {
    defaultTimeZone: config.OWNER_TIME_ZONE,
    ownerDataKeys,
    channelProviderId
  })
  const conversations = createConversationStore(applicationStorage, protection, {
    ownerId: config.OWNER_ID,
    ownerTimeZone: config.OWNER_TIME_ZONE,
    ownerDataKeys,
    channelProviderId
  })
  const turns = createConversationTurnStore(applicationStorage, protection, {
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
    ownerTimeZone: config.OWNER_TIME_ZONE
  })
  const alerts = createAlertStore(applicationStorage, {})
  const productionDataInspector = createProductionDataInspector(applicationStorage)
  const artifacts = createArtifactStore(applicationStorage, protection, {
    legacyReaders: prepared.legacyArtifactReaders,
    ownerDataKeys
  })
  const delivery = createDeliveryStore(applicationStorage, protection, {
    channelProviderId,
    targetAdapters: prepared.deliveryTargets,
    ownerDataKeys
  })
  const privateText = createPrivateTextReader(applicationStorage, protection, ownerDataKeys)
  const evidenceSources = createEvidenceSourceRegistry(runtimeProfile.catalogue.profileId, [
    createConversationEvidenceSource(applicationStorage, privateText, protection),
    createFactEvidenceSource(applicationStorage, privateText, protection),
    ...prepared.evidenceSources
  ])
  const memory = createMemoryStore(applicationStorage, protection, evidenceSources, {
    ownerDataKeys
  })
  const retrieval = createRetrievalPipeline(applicationStorage)
  const context = createApplicationContextStore(
    applicationStorage,
    protection,
    runtimeProfile.catalogue,
    {
      artifacts,
      retrieval,
      ownerDataKeys
    }
  )
  const runs = createAgentRunStore(applicationStorage, protection, { ownerDataKeys })
  const agentRuns = createAgentRuns(applicationStorage, protection, { ownerDataKeys })
  const agentRunGateway = createAgentRunGateway(applicationStorage, protection, { ownerDataKeys })
  const toolAdapters = createToolAdapterRegistry(runtimeProfile.catalogue, [
    createMemoryToolAdapter(memory, retrieval),
    createSettingsToolAdapter(settings),
    ...prepared.toolAdapters
  ])
  const tools = createToolExecutor(applicationStorage, protection, toolAdapters, {
    toolLeaseMs: conversationTiming.mutationSettleLeaseMs,
    ownerDataKeys
  })
  const agentExperience = createAgentExperienceRegistry(runtimeProfile.catalogue.profileId, [])
  const reviewedSkills = createReviewedSkillRegistry(runtimeProfile.catalogue.profileId, [])
  const ownerDataKeysLayer = ownerDataKeyStoreLayer(ownerDataKeys)
  const attachmentsLayer = messageAttachmentStoreLayer(applicationStorage, protection).pipe(
    Layer.provide(Layer.merge(ownerDataKeysLayer, adapters.objectStorage))
  )
  const layer = Layer.mergeAll(
    conversationStoreLayer(conversations),
    conversationTurnStoreLayer(turns),
    ownerDataKeysLayer,
    attachmentsLayer,
    alertStoreLayer(alerts),
    productionDataInspectorLayer(productionDataInspector),
    artifactStoreLayer(artifacts),
    deliveryStoreLayer(delivery),
    memoryStoreLayer(memory),
    retrievalPipelineLayer(retrieval),
    ownerSettingsStoreLayer(settings),
    contextStoreLayer(context),
    agentRunStoreLayer(runs),
    agentRunsLayer(agentRuns),
    agentRunGatewayLayer(agentRunGateway),
    toolExecutorLayer(tools)
  )
  return {
    config,
    profile: runtimeProfile.catalogue,
    modules: prepared.runtimeModules,
    layer,
    memoryClasses: Object.freeze({ agentExperience, reviewedSkills }),
    jobQueue: adapters.jobQueue,
    runCoordinator: adapters.runCoordinator,
    applicationStorage
  }
}
