import type { ConnectionStore } from "@bob/connections-service/store"
import type { TransitionalBindings } from "@bob/core-types/bindings"
import type { JournalStore } from "@bob/journal-service/store"

import { makeConnectionsGatewayClient } from "@bob/connections-service/gateway"
import { makeConnectionOwnerRoutes } from "@bob/connections-service/owner-routes"
import { makeConnectionStore } from "@bob/connections-service/store"
import { makeConnectionsToolAdapter } from "@bob/connections-service/tool-adapter"
import { transitionalDeploymentProfile } from "@bob/core-types/profiles/transitional"
import { makeRuntimeModules } from "@bob/core-types/runtime-module"
import { makeJournalConversationWorkflow } from "@bob/journal-service/conversation-workflow"
import { makeJournalEvidenceSource } from "@bob/journal-service/evidence-source"
import { makeJournalOwnerRoutes } from "@bob/journal-service/owner-routes"
import { makeJournalStore } from "@bob/journal-service/store"
import { makeJournalToolAdapter } from "@bob/journal-service/tool-adapter"
import { makeReminderConversationWorkflow } from "@bob/reminders-service/conversation-workflow"
import { makeReminderDeliveryTarget } from "@bob/reminders-service/delivery-target"
import { makeReminderEvidenceSource } from "@bob/reminders-service/evidence-source"
import { makeReminderOwnerRoutes } from "@bob/reminders-service/owner-routes"
import { makeReminderScheduledWorkflow } from "@bob/reminders-service/scheduled-workflow"
import { makeReminderStore, type ReminderStore } from "@bob/reminders-service/store"
import { makeReminderToolAdapter } from "@bob/reminders-service/tool-adapter"
import { makeTrainingConversationWorkflow } from "@bob/training-service/conversation-workflow"
import { makeTrainingEvidenceSource } from "@bob/training-service/evidence-source"
import { legacyTrainingArtifactReader } from "@bob/training-service/legacy-artifact"
import { makeTrainingModule, type TrainingModule } from "@bob/training-service/module"
import { makeTrainingOwnerRoutes } from "@bob/training-service/owner-routes"
import { makeTrainingProposalStore } from "@bob/training-service/proposal-store"
import { makeTrainingStore } from "@bob/training-service/store"
import { makeTrainingToolAdapter } from "@bob/training-service/tool-adapter"
import { Schema } from "effect"

import type { DeploymentRuntimeProfile } from "./types.ts"

const Configuration = Schema.Struct({
  REMINDER_QUIET_HOURS_START: Schema.String.check(Schema.isPattern(/^(?:[01]\d|2[0-3]):[0-5]\d$/)),
  REMINDER_QUIET_HOURS_END: Schema.String.check(Schema.isPattern(/^(?:[01]\d|2[0-3]):[0-5]\d$/)),
  REMINDER_DAILY_LIMIT: Schema.Number.check(
    Schema.isInt(),
    Schema.isBetween({ minimum: 1, maximum: 100 })
  ),
  UI_BASE_URL: Schema.String,
  CONNECTIONS_GATEWAY_URL: Schema.String,
  CONNECTIONS_GATEWAY_CALLER_SECRET: Schema.String.check(Schema.isMinLength(32))
})

export interface TransitionalExtensions {
  readonly reminders: ReminderStore
  readonly journal: JournalStore
  readonly training: TrainingModule
  readonly connections: ConnectionStore
}

export const transitionalRuntimeProfile: DeploymentRuntimeProfile<TransitionalExtensions> = {
  catalogue: transitionalDeploymentProfile,
  prepare(context) {
    // SAFETY: This static profile is selected only for the transitional Worker binding set.
    const config = Schema.decodeUnknownSync(Configuration)(context.bindings as TransitionalBindings)
    const connections = makeConnectionStore(
      context.database,
      makeConnectionsGatewayClient({
        url: config.CONNECTIONS_GATEWAY_URL,
        callerSecret: config.CONNECTIONS_GATEWAY_CALLER_SECRET
      }),
      {}
    )
    const reminders = makeReminderStore(context.database, context.protection, {
      quietHours: {
        start: config.REMINDER_QUIET_HOURS_START,
        end: config.REMINDER_QUIET_HOURS_END,
        timeZone: context.ownerTimeZone
      },
      dailyLimit: config.REMINDER_DAILY_LIMIT,
      ownerDataKeys: context.ownerDataKeys
    })
    const journal = makeJournalStore(context.database, context.protection, {
      ownerDataKeys: context.ownerDataKeys
    })
    const trainingStore = makeTrainingStore(context.database, {})
    const training = makeTrainingModule(
      trainingStore,
      makeTrainingProposalStore(context.database, context.protection, trainingStore, {
        ownerDataKeys: context.ownerDataKeys
      })
    )
    return {
      evidenceSources: [
        makeJournalEvidenceSource(context.database, context.protection),
        makeReminderEvidenceSource(context.database, context.protection),
        makeTrainingEvidenceSource(context.database, context.protection)
      ],
      legacyArtifactReaders: [legacyTrainingArtifactReader],
      deliveryTargets: [makeReminderDeliveryTarget(context.database)],
      runtime: makeRuntimeModules({
        conversations: [
          makeTrainingConversationWorkflow(training),
          makeJournalConversationWorkflow(journal, context.turns, config.UI_BASE_URL),
          makeReminderConversationWorkflow(context.conversations, reminders)
        ],
        ownerRoutes: [
          makeConnectionOwnerRoutes(connections),
          makeReminderOwnerRoutes(reminders),
          makeJournalOwnerRoutes(journal),
          makeTrainingOwnerRoutes(training)
        ],
        scheduledTasks: [
          makeReminderScheduledWorkflow({
            // SAFETY: This static profile is selected only for the transitional Worker binding set.
            bindings: context.bindings as TransitionalBindings,
            database: context.database,
            reminders,
            ownerId: context.ownerId
          })
        ]
      }),
      extensions: { reminders, journal, training, connections },
      toolAdapters() {
        return [
          makeReminderToolAdapter(reminders),
          makeJournalToolAdapter(journal, context.turns, { uiBaseUrl: config.UI_BASE_URL }),
          makeTrainingToolAdapter(training),
          makeConnectionsToolAdapter(connections)
        ]
      }
    }
  }
}
