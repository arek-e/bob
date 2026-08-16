import { transitionalDeploymentProfile } from "@bob/contracts/deployment-profiles/transitional"
import { Schema } from "effect"

import type { TransitionalBindings } from "../bindings.ts"
import type { ConnectionStore } from "../modules/connections/store.ts"
import type { JournalStore } from "../modules/journal/store.ts"
import type { DeploymentRuntimeProfile } from "./types.ts"

import { makeConnectionsGatewayClient } from "../modules/connections/gateway.ts"
import { makeConnectionOwnerRoutes } from "../modules/connections/owner-routes.ts"
import { makeConnectionStore } from "../modules/connections/store.ts"
import { makeConnectionsToolAdapter } from "../modules/connections/tool-adapter.ts"
import { makeJournalConversationWorkflow } from "../modules/journal/conversation-workflow.ts"
import { makeJournalEvidenceSource } from "../modules/journal/evidence-source.ts"
import { makeJournalOwnerRoutes } from "../modules/journal/owner-routes.ts"
import { makeJournalStore } from "../modules/journal/store.ts"
import { makeJournalToolAdapter } from "../modules/journal/tool-adapter.ts"
import { makeReminderConversationWorkflow } from "../modules/reminders/conversation-workflow.ts"
import { makeReminderDeliveryTarget } from "../modules/reminders/delivery-target.ts"
import { makeReminderEvidenceSource } from "../modules/reminders/evidence-source.ts"
import { makeReminderOwnerRoutes } from "../modules/reminders/owner-routes.ts"
import { makeReminderScheduledWorkflow } from "../modules/reminders/scheduled-workflow.ts"
import { makeReminderStore, type ReminderStore } from "../modules/reminders/store.ts"
import { makeReminderToolAdapter } from "../modules/reminders/tool-adapter.ts"
import { makeRuntimeModules } from "../modules/runtime/module.ts"
import { makeTrainingConversationWorkflow } from "../modules/training/conversation-workflow.ts"
import { makeTrainingEvidenceSource } from "../modules/training/evidence-source.ts"
import { legacyTrainingArtifactReader } from "../modules/training/legacy-artifact.ts"
import { makeTrainingModule, type TrainingModule } from "../modules/training/module.ts"
import { makeTrainingOwnerRoutes } from "../modules/training/owner-routes.ts"
import { makeTrainingProposalStore } from "../modules/training/proposal-store.ts"
import { makeTrainingStore } from "../modules/training/store.ts"
import { makeTrainingToolAdapter } from "../modules/training/tool-adapter.ts"

const Configuration = Schema.Struct({
  REMINDER_QUIET_HOURS_START: Schema.String.check(Schema.isPattern(/^(?:[01]\d|2[0-3]):[0-5]\d$/)),
  REMINDER_QUIET_HOURS_END: Schema.String.check(Schema.isPattern(/^(?:[01]\d|2[0-3]):[0-5]\d$/)),
  REMINDER_DAILY_LIMIT: Schema.Number.check(
    Schema.isInt(),
    Schema.isBetween({ minimum: 1, maximum: 100 })
  ),
  UI_BASE_URL: Schema.String,
  CONNECTIONS_GATEWAY_URL: Schema.String,
  CONNECTIONS_GATEWAY_ACCESS_CLIENT_ID: Schema.String.check(Schema.isMinLength(1)),
  CONNECTIONS_GATEWAY_ACCESS_CLIENT_SECRET: Schema.String.check(Schema.isMinLength(1))
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
        accessClientId: config.CONNECTIONS_GATEWAY_ACCESS_CLIENT_ID,
        accessClientSecret: config.CONNECTIONS_GATEWAY_ACCESS_CLIENT_SECRET
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
