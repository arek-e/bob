import type { PreparedVerticalModule, VerticalModule } from "@bob/deployment-profile-types/runtime"

import { makeRuntimeModules } from "@bob/core-types/runtime-module"
import { reminderCapability } from "@bob/reminders-types/capability"
import { Schema } from "effect"

import { makeReminderConversationWorkflow } from "./conversation-workflow.ts"
import { makeReminderDeliveryTarget } from "./delivery-target.ts"
import { makeReminderEvidenceSource } from "./evidence-source.ts"
import { makeReminderOwnerRoutes } from "./owner-routes.ts"
import { makeReminderScheduledWorkflow } from "./scheduled-workflow.ts"
import { makeReminderStore } from "./store.ts"
import { makeReminderToolAdapter } from "./tool-adapter.ts"

const Configuration = Schema.Struct({
  REMINDER_CLOCK: Schema.Unknown,
  REMINDER_QUIET_HOURS_START: Schema.String.check(Schema.isPattern(/^(?:[01]\d|2[0-3]):[0-5]\d$/)),
  REMINDER_QUIET_HOURS_END: Schema.String.check(Schema.isPattern(/^(?:[01]\d|2[0-3]):[0-5]\d$/)),
  REMINDER_DAILY_LIMIT: Schema.Number.check(
    Schema.isInt(),
    Schema.isBetween({ minimum: 1, maximum: 100 })
  )
})

interface ReminderClock {
  readonly fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
}

function reminderConfiguration(bindings: unknown): Omit<
  typeof Configuration.Type,
  "REMINDER_CLOCK"
> & {
  readonly REMINDER_CLOCK: ReminderClock
} {
  const config = Schema.decodeUnknownSync(Configuration)(bindings)
  if (
    config.REMINDER_CLOCK === null ||
    typeof config.REMINDER_CLOCK !== "object" ||
    typeof Reflect.get(config.REMINDER_CLOCK, "fetch") !== "function"
  ) {
    throw new TypeError("REMINDER_CLOCK.fetch is required")
  }
  return { ...config, REMINDER_CLOCK: config.REMINDER_CLOCK as ReminderClock }
}

export const reminderVerticalModule: VerticalModule = {
  id: reminderCapability.id,
  capability: reminderCapability,
  prepare(context): PreparedVerticalModule {
    const config = reminderConfiguration(context.bindings)
    const reminders = makeReminderStore(context.database, context.protection, {
      quietHours: {
        start: config.REMINDER_QUIET_HOURS_START,
        end: config.REMINDER_QUIET_HOURS_END,
        timeZone: context.ownerTimeZone
      },
      dailyLimit: config.REMINDER_DAILY_LIMIT,
      ownerDataKeys: context.ownerDataKeys
    })

    return {
      id: reminderCapability.id,
      capability: reminderCapability,
      evidenceSources: [makeReminderEvidenceSource(context.database, context.protection)],
      legacyArtifactReaders: [],
      deliveryTargets: [makeReminderDeliveryTarget(context.database)],
      runtimeModules: makeRuntimeModules({
        conversations: [makeReminderConversationWorkflow(context.conversations, reminders)],
        ownerRoutes: [makeReminderOwnerRoutes(reminders)],
        scheduledTasks: [
          makeReminderScheduledWorkflow({
            clock: config.REMINDER_CLOCK,
            database: context.database,
            reminders,
            ownerId: context.ownerId
          })
        ]
      }),
      toolAdapters: [makeReminderToolAdapter(reminders)]
    }
  }
}
