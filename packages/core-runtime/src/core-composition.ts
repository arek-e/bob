import type { GeneralCoreBindings } from "@bob/core-types/bindings"

import { AlertStore, alertStoreLayer, makeAlertStore } from "@bob/core-service/alerts/store"
import {
  ArtifactStore,
  artifactStoreLayer,
  makeArtifactStore
} from "@bob/core-service/artifacts/store"
import { makeApplicationContextStore } from "@bob/core-service/context/composition"
import { makePrivateTextReader } from "@bob/core-service/context/private-text"
import { ContextStore, contextStoreLayer } from "@bob/core-service/context/store"
import { makeConversationEvidenceSource } from "@bob/core-service/conversations/evidence-source"
import {
  AgentRunStore,
  agentRunStoreLayer,
  makeAgentRunStore
} from "@bob/core-service/conversations/run-store"
import {
  ConversationStore,
  conversationStoreLayer,
  makeConversationStore
} from "@bob/core-service/conversations/store"
import { conversationTiming } from "@bob/core-service/conversations/timing"
import { makeToolAdapterRegistry } from "@bob/core-service/conversations/tool-adapter"
import {
  ToolExecutor,
  makeToolExecutor,
  toolExecutorLayer
} from "@bob/core-service/conversations/tool-executor"
import {
  ConversationTurnStore,
  conversationTurnStoreLayer,
  makeConversationTurnStore
} from "@bob/core-service/conversations/turn-store"
import {
  DeliveryStore,
  deliveryStoreLayer,
  makeDeliveryStore
} from "@bob/core-service/delivery/store"
import { makeAgentExperienceRegistry } from "@bob/core-service/memory/agent-experience"
import { makeEvidenceSourceRegistry } from "@bob/core-service/memory/evidence"
import { makeFactEvidenceSource } from "@bob/core-service/memory/evidence-source"
import { MemoryStore, makeMemoryStore, memoryStoreLayer } from "@bob/core-service/memory/store"
import { makeMemoryToolAdapter } from "@bob/core-service/memory/tool-adapter"
import { createDataProtection } from "@bob/core-service/policy/data-protection"
import {
  OwnerDataKeyStore,
  makeOwnerDataKeyStore,
  ownerDataKeyStoreLayer
} from "@bob/core-service/policy/owner-data-key"
import {
  RetrievalPipeline,
  makeRetrievalPipeline,
  retrievalPipelineLayer
} from "@bob/core-service/retrieval/pipeline"
import {
  OwnerSettingsStore,
  makeOwnerSettingsStore,
  ownerSettingsStoreLayer
} from "@bob/core-service/settings/store"
import { makeSettingsToolAdapter } from "@bob/core-service/settings/tool-adapter"
import { makeReviewedSkillRegistry } from "@bob/core-service/skills/registry"
import { Effect, Layer, Schema } from "effect"

import type { DeploymentRuntimeProfile } from "./profiles/types.ts"
import type { CoreRuntimeAdapters } from "./runtime/core-runtime.ts"

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
  runtimeProfile: DeploymentRuntimeProfile<Extensions>,
  adapters: CoreRuntimeAdapters
) {
  const config = Schema.decodeUnknownSync(Configuration)(bindings)
  const { applicationStorage, events, channelProviderId } = adapters
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
  const services = Effect.runSync(
    Effect.gen(function* () {
      return {
        events,
        ownerDataKeys: yield* OwnerDataKeyStore,
        conversations: yield* ConversationStore,
        turns: yield* ConversationTurnStore,
        alerts: yield* AlertStore,
        artifacts: yield* ArtifactStore,
        delivery: yield* DeliveryStore,
        memory: yield* MemoryStore,
        retrieval: yield* RetrievalPipeline,
        settings: yield* OwnerSettingsStore,
        context: yield* ContextStore,
        runs: yield* AgentRunStore,
        tools: yield* ToolExecutor
      }
    }).pipe(Effect.provide(layer))
  )

  return {
    config,
    profile: runtimeProfile.catalogue,
    runtime: prepared.runtime,
    extensions: prepared.extensions,
    memoryClasses: Object.freeze({ agentExperience, reviewedSkills }),
    jobQueue: adapters.jobQueue,
    objectStorage: adapters.objectStorage,
    runCoordinator: adapters.runCoordinator,
    applicationStorage,
    // Compatibility aliases keep existing Module and test callers stable.
    jobs: adapters.jobQueue,
    privateObjects: adapters.objectStorage,
    ownerRunCoordinator: adapters.runCoordinator,
    database: applicationStorage,
    layer,
    services
  }
}
