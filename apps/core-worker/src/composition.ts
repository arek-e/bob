import { transitionalDeploymentProfile } from "@bob/contracts/deployment-profiles"
import { cloudflareEventSink } from "@bob/observability/cloudflare"
import { Effect, Layer, Schema } from "effect"

import type { CoreBindings } from "./bindings.ts"

import { createCoreDatabase } from "./database.ts"
import { AlertStore, makeAlertStore, alertStoreLayer } from "./modules/alerts/store.ts"
import { ArtifactStore, artifactStoreLayer, makeArtifactStore } from "./modules/artifacts/store.ts"
import { makeConnectionsGatewayClient } from "./modules/connections/gateway.ts"
import {
  ConnectionStore,
  connectionStoreLayer,
  makeConnectionStore
} from "./modules/connections/store.ts"
import { makeConnectionsToolAdapter } from "./modules/connections/tool-adapter.ts"
import { makeApplicationContextStore } from "./modules/context/composition.ts"
import { makePrivateTextReader } from "./modules/context/private-text.ts"
import { ContextStore, contextStoreLayer } from "./modules/context/store.ts"
import { makeConversationEvidenceSource } from "./modules/conversations/evidence-source.ts"
import {
  AgentRunStore,
  makeAgentRunStore,
  agentRunStoreLayer
} from "./modules/conversations/run-store.ts"
import {
  ConversationStore,
  makeConversationStore,
  conversationStoreLayer
} from "./modules/conversations/store.ts"
import { conversationTiming } from "./modules/conversations/timing.ts"
import { makeToolAdapterRegistry } from "./modules/conversations/tool-adapter.ts"
import {
  ToolExecutor,
  makeToolExecutor,
  toolExecutorLayer
} from "./modules/conversations/tool-executor.ts"
import {
  ConversationTurnStore,
  conversationTurnStoreLayer,
  makeConversationTurnStore
} from "./modules/conversations/turn-store.ts"
import { DeliveryStore, makeDeliveryStore, deliveryStoreLayer } from "./modules/delivery/store.ts"
import { makeJournalEvidenceSource } from "./modules/journal/evidence-source.ts"
import { JournalStore, makeJournalStore, journalStoreLayer } from "./modules/journal/store.ts"
import { makeJournalToolAdapter } from "./modules/journal/tool-adapter.ts"
import { makeAgentExperienceRegistry } from "./modules/memory/agent-experience.ts"
import { makeFactEvidenceSource } from "./modules/memory/evidence-source.ts"
import { makeEvidenceSourceRegistry } from "./modules/memory/evidence.ts"
import { MemoryStore, makeMemoryStore, memoryStoreLayer } from "./modules/memory/store.ts"
import { makeMemoryToolAdapter } from "./modules/memory/tool-adapter.ts"
import { createDataProtection } from "./modules/policy/data-protection.ts"
import { makeReminderEvidenceSource } from "./modules/reminders/evidence-source.ts"
import { ReminderStore, makeReminderStore, reminderStoreLayer } from "./modules/reminders/store.ts"
import { makeReminderToolAdapter } from "./modules/reminders/tool-adapter.ts"
import {
  RetrievalPipeline,
  makeRetrievalPipeline,
  retrievalPipelineLayer
} from "./modules/retrieval/pipeline.ts"
import {
  OwnerSettingsStore,
  makeOwnerSettingsStore,
  ownerSettingsStoreLayer
} from "./modules/settings/store.ts"
import { makeSettingsToolAdapter } from "./modules/settings/tool-adapter.ts"
import { makeReviewedSkillRegistry } from "./modules/skills/registry.ts"
import { makeTrainingEvidenceSource } from "./modules/training/evidence-source.ts"
import { legacyTrainingArtifactReader } from "./modules/training/legacy-artifact.ts"
import {
  TrainingModule,
  makeTrainingModule,
  trainingModuleLayer
} from "./modules/training/module.ts"
import { makeTrainingProposalStore } from "./modules/training/proposal-store.ts"
import { makeTrainingStore, trainingStoreLayer } from "./modules/training/store.ts"
import { makeTrainingToolAdapter } from "./modules/training/tool-adapter.ts"

const Configuration = Schema.Struct({
  OWNER_ID: Schema.String.check(Schema.isUUID()),
  OWNER_TIME_ZONE: Schema.String,
  REMINDER_QUIET_HOURS_START: Schema.String.check(Schema.isPattern(/^(?:[01]\d|2[0-3]):[0-5]\d$/)),
  REMINDER_QUIET_HOURS_END: Schema.String.check(Schema.isPattern(/^(?:[01]\d|2[0-3]):[0-5]\d$/)),
  REMINDER_DAILY_LIMIT: Schema.Number.check(
    Schema.isInt(),
    Schema.isBetween({ minimum: 1, maximum: 100 })
  ),
  DATA_KEK_ACTIVE_VERSION: Schema.String,
  DATA_KEK_KEYRING_JSON: Schema.String.check(Schema.isMinLength(1)),
  DATA_LOOKUP_KEY: Schema.String.check(Schema.isMinLength(40)),
  INGRESS_CALLER_SECRET: Schema.String.check(Schema.isMinLength(32)),
  EGRESS_CALLER_SECRET: Schema.String.check(Schema.isMinLength(32)),
  SENDBLUE_EGRESS_URL: Schema.String,
  BETTER_AUTH_SECRET: Schema.String.check(Schema.isMinLength(32)),
  ACCESS_TEAM_DOMAIN: Schema.String.check(Schema.isPattern(/^[a-z0-9-]+\.cloudflareaccess\.com$/)),
  CORE_ACCESS_AUDIENCE: Schema.String.check(Schema.isMinLength(1)),
  SETUP_ACCESS_AUDIENCE: Schema.String.check(Schema.isMinLength(1)),
  OWNER_ACCESS_EMAIL: Schema.String.check(Schema.isMinLength(3)),
  AGENT_CALLER_SUBJECT: Schema.String.check(Schema.isMinLength(1)),
  AGENT_URL: Schema.String,
  AGENT_ACCESS_CLIENT_ID: Schema.String,
  AGENT_ACCESS_CLIENT_SECRET: Schema.String,
  AGENT_ADMIN_URL: Schema.String,
  AGENT_ADMIN_ACCESS_CLIENT_ID: Schema.String,
  AGENT_ADMIN_ACCESS_CLIENT_SECRET: Schema.String,
  UI_BASE_URL: Schema.String,
  CONNECTIONS_GATEWAY_URL: Schema.String,
  CONNECTIONS_GATEWAY_ACCESS_CLIENT_ID: Schema.String.check(Schema.isMinLength(1)),
  CONNECTIONS_GATEWAY_ACCESS_CLIENT_SECRET: Schema.String.check(Schema.isMinLength(1)),
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

export function composeCore(bindings: CoreBindings) {
  const config = Schema.decodeUnknownSync(Configuration)(bindings)
  const events = cloudflareEventSink()
  const database = createCoreDatabase(bindings.DB)
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
  const settings = makeOwnerSettingsStore(database, protection, {
    defaultTimeZone: config.OWNER_TIME_ZONE
  })
  const connections = makeConnectionStore(
    database,
    makeConnectionsGatewayClient({
      url: config.CONNECTIONS_GATEWAY_URL,
      accessClientId: config.CONNECTIONS_GATEWAY_ACCESS_CLIENT_ID,
      accessClientSecret: config.CONNECTIONS_GATEWAY_ACCESS_CLIENT_SECRET
    }),
    {}
  )
  const conversations = makeConversationStore(database, protection, {
    ownerId: config.OWNER_ID,
    ownerTimeZone: config.OWNER_TIME_ZONE,
    dataKeyVersion: activeKekVersion
  })
  const turns = makeConversationTurnStore(database, protection, { ownerId: config.OWNER_ID })
  const alerts = makeAlertStore(database, {})
  const artifacts = makeArtifactStore(database, protection, {
    legacyReaders: [legacyTrainingArtifactReader]
  })
  const delivery = makeDeliveryStore(database, protection, {})
  const reminders = makeReminderStore(database, protection, {
    quietHours: {
      start: config.REMINDER_QUIET_HOURS_START,
      end: config.REMINDER_QUIET_HOURS_END,
      timeZone: config.OWNER_TIME_ZONE
    },
    dailyLimit: config.REMINDER_DAILY_LIMIT
  })
  const privateText = makePrivateTextReader(database, protection)
  const evidenceSources = makeEvidenceSourceRegistry(transitionalDeploymentProfile.profileId, [
    makeConversationEvidenceSource(database, privateText, protection),
    makeFactEvidenceSource(database, privateText, protection),
    makeJournalEvidenceSource(database, protection),
    makeReminderEvidenceSource(database, protection),
    makeTrainingEvidenceSource(database, protection)
  ])
  const agentExperience = makeAgentExperienceRegistry(transitionalDeploymentProfile.profileId, [])
  const reviewedSkills = makeReviewedSkillRegistry(transitionalDeploymentProfile.profileId, [])
  const memory = makeMemoryStore(database, protection, evidenceSources, {})
  const retrieval = makeRetrievalPipeline(database)
  const journal = makeJournalStore(database, protection, {})
  const trainingStore = makeTrainingStore(database, {})
  const training = makeTrainingModule(
    trainingStore,
    makeTrainingProposalStore(database, protection, trainingStore, {})
  )
  const context = makeApplicationContextStore(database, protection, transitionalDeploymentProfile, {
    artifacts,
    retrieval
  })
  const runs = makeAgentRunStore(database, protection, {})
  const toolAdapters = makeToolAdapterRegistry(transitionalDeploymentProfile, [
    makeReminderToolAdapter(reminders),
    makeMemoryToolAdapter(memory, retrieval),
    makeJournalToolAdapter(journal, turns, { uiBaseUrl: config.UI_BASE_URL }),
    makeTrainingToolAdapter(training),
    makeSettingsToolAdapter(settings),
    makeConnectionsToolAdapter(connections)
  ])
  const tools = makeToolExecutor(database, protection, toolAdapters, {
    toolLeaseMs: conversationTiming.mutationSettleLeaseMs
  })

  const layer = Layer.mergeAll(
    conversationStoreLayer(conversations),
    conversationTurnStoreLayer(turns),
    alertStoreLayer(alerts),
    artifactStoreLayer(artifacts),
    deliveryStoreLayer(delivery),
    reminderStoreLayer(reminders),
    memoryStoreLayer(memory),
    retrievalPipelineLayer(retrieval),
    journalStoreLayer(journal),
    trainingStoreLayer(trainingStore),
    trainingModuleLayer(training),
    ownerSettingsStoreLayer(settings),
    connectionStoreLayer(connections),
    contextStoreLayer(context),
    agentRunStoreLayer(runs),
    toolExecutorLayer(tools)
  )
  const services = Effect.runSync(
    Effect.gen(function* () {
      return {
        events,
        conversations: yield* ConversationStore,
        turns: yield* ConversationTurnStore,
        alerts: yield* AlertStore,
        artifacts: yield* ArtifactStore,
        delivery: yield* DeliveryStore,
        reminders: yield* ReminderStore,
        memory: yield* MemoryStore,
        retrieval: yield* RetrievalPipeline,
        journal: yield* JournalStore,
        training: yield* TrainingModule,
        settings: yield* OwnerSettingsStore,
        connections: yield* ConnectionStore,
        context: yield* ContextStore,
        runs: yield* AgentRunStore,
        tools: yield* ToolExecutor
      }
    }).pipe(Effect.provide(layer))
  )

  return {
    config,
    profile: transitionalDeploymentProfile,
    memoryClasses: Object.freeze({ agentExperience, reviewedSkills }),
    database,
    layer,
    services
  }
}

export type CoreComposition = ReturnType<typeof composeCore>
