import { Effect, Layer, Schema } from "effect"

import type { CoreBindings } from "./bindings.ts"
import { createCoreDatabase } from "./database.ts"
import { AlertStore, makeAlertStore, alertStoreLayer } from "./modules/alerts/store.ts"
import { ContextStore, makeContextStore, contextStoreLayer } from "./modules/context/store.ts"
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
import {
  ToolExecutor,
  makeToolExecutor,
  toolExecutorLayer
} from "./modules/conversations/tool-executor.ts"
import { DeliveryStore, makeDeliveryStore, deliveryStoreLayer } from "./modules/delivery/store.ts"
import { JournalStore, makeJournalStore, journalStoreLayer } from "./modules/journal/store.ts"
import { MemoryStore, makeMemoryStore, memoryStoreLayer } from "./modules/memory/store.ts"
import { createDataProtection } from "./modules/policy/data-protection.ts"
import { ReminderStore, makeReminderStore, reminderStoreLayer } from "./modules/reminders/store.ts"
import { TrainingStore, makeTrainingStore, trainingStoreLayer } from "./modules/training/store.ts"

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
  ACCESS_TEAM_DOMAIN: Schema.String.check(Schema.isPattern(/^[a-z0-9-]+\.cloudflareaccess\.com$/)),
  CORE_ACCESS_AUDIENCE: Schema.String.check(Schema.isMinLength(1)),
  OWNER_ACCESS_EMAIL: Schema.String.check(Schema.isMinLength(3)),
  AGENT_CALLER_SUBJECT: Schema.String.check(Schema.isMinLength(1)),
  AGENT_URL: Schema.String,
  AGENT_ACCESS_CLIENT_ID: Schema.String,
  AGENT_ACCESS_CLIENT_SECRET: Schema.String,
  AGENT_ADMIN_URL: Schema.String,
  AGENT_ADMIN_ACCESS_CLIENT_ID: Schema.String,
  AGENT_ADMIN_ACCESS_CLIENT_SECRET: Schema.String,
  UI_BASE_URL: Schema.String,
  BOB_MODEL: Schema.String,
  BOB_PROVIDER: Schema.Literal("openai-codex")
})

export function composeCore(bindings: CoreBindings) {
  const config = Schema.decodeUnknownSync(Configuration)(bindings)
  const database = createCoreDatabase(bindings.DB)
  const activeKekVersion = Number.parseInt(config.DATA_KEK_ACTIVE_VERSION, 10)
  const keyringInput = Schema.decodeUnknownSync(
    Schema.Record(Schema.String, Schema.String.check(Schema.isMinLength(40)))
  )(JSON.parse(config.DATA_KEK_KEYRING_JSON) as unknown)
  const keyring = Object.fromEntries(
    Object.entries(keyringInput).map(([version, value]) => {
      const parsed = Number.parseInt(version, 10)
      if (!Number.isInteger(parsed) || parsed < 1) throw new Error("Invalid KEK version")
      return [parsed, value]
    })
  )
  if (keyring[activeKekVersion] === undefined) throw new Error("Active KEK is missing")
  const protection = createDataProtection(keyring, activeKekVersion, config.DATA_LOOKUP_KEY)
  const conversations = makeConversationStore(database, protection, {
    ownerId: config.OWNER_ID,
    ownerTimeZone: config.OWNER_TIME_ZONE,
    dataKeyVersion: activeKekVersion
  })
  const alerts = makeAlertStore(database, {})
  const delivery = makeDeliveryStore(database, protection, {})
  const reminders = makeReminderStore(database, protection, {
    quietHours: {
      start: config.REMINDER_QUIET_HOURS_START,
      end: config.REMINDER_QUIET_HOURS_END,
      timeZone: config.OWNER_TIME_ZONE
    },
    dailyLimit: config.REMINDER_DAILY_LIMIT
  })
  const memory = makeMemoryStore(database, protection, {})
  const journal = makeJournalStore(database, protection, {})
  const training = makeTrainingStore(database, {})
  const context = makeContextStore(database, protection, {})
  const runs = makeAgentRunStore(database, protection, {})
  const tools = makeToolExecutor(
    database,
    protection,
    { reminders, memory, journal, training },
    { uiBaseUrl: config.UI_BASE_URL }
  )

  const layer = Layer.mergeAll(
    conversationStoreLayer(conversations),
    alertStoreLayer(alerts),
    deliveryStoreLayer(delivery),
    reminderStoreLayer(reminders),
    memoryStoreLayer(memory),
    journalStoreLayer(journal),
    trainingStoreLayer(training),
    contextStoreLayer(context),
    agentRunStoreLayer(runs),
    toolExecutorLayer(tools)
  )
  const services = Effect.runSync(
    Effect.gen(function* () {
      return {
        conversations: yield* ConversationStore,
        alerts: yield* AlertStore,
        delivery: yield* DeliveryStore,
        reminders: yield* ReminderStore,
        memory: yield* MemoryStore,
        journal: yield* JournalStore,
        training: yield* TrainingStore,
        context: yield* ContextStore,
        runs: yield* AgentRunStore,
        tools: yield* ToolExecutor
      }
    }).pipe(Effect.provide(layer))
  )

  return {
    config,
    database,
    layer,
    services
  }
}

export type CoreComposition = ReturnType<typeof composeCore>
