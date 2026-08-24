import type { PreparedVerticalModule, VerticalModule } from "@bob/deployment-profile-types/runtime"

import { createRuntimeModules } from "@bob/core-types/runtime-module"
import { reminderCapability } from "@bob/reminders-types/capability"
import { Predicate, Schema } from "effect"

import { createReminderConversationWorkflow } from "./conversation-workflow.ts"
import { createReminderDeliveryTarget } from "./delivery-target.ts"
import { createReminderEvidenceSource } from "./evidence-source.ts"
import { createReminderOwnerRoutes } from "./owner-routes.ts"
import { createReminderScheduledWorkflow } from "./scheduled-workflow.ts"
import { createReminderStore } from "./store.ts"
import { createReminderToolAdapter } from "./tool-adapter.ts"

const Configuration = Schema.Struct({
  REMINDER_CLOCK: Schema.Struct({ fetch: Schema.optionalKey(Schema.Any) }),
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

export const reminderVerticalModule: VerticalModule = {
  id: reminderCapability.id,
  capability: reminderCapability,
  prepare(context): PreparedVerticalModule {
    const parsed = Schema.decodeUnknownSync(Configuration)(context.bindings)
    if (!Predicate.isFunction(parsed.REMINDER_CLOCK.fetch)) {
      throw new TypeError("REMINDER_CLOCK.fetch is required")
    }
    // SAFETY: The configuration schema checks the clock object, and Predicate checks its fetch member.
    const config = { ...parsed, REMINDER_CLOCK: parsed.REMINDER_CLOCK as ReminderClock }
    const reminders = createReminderStore(context.database, context.protection, {
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
      evidenceSources: [createReminderEvidenceSource(context.database, context.protection)],
      legacyArtifactReaders: [],
      deliveryTargets: [createReminderDeliveryTarget(context.database)],
      runtimeModules: createRuntimeModules({
        conversations: [createReminderConversationWorkflow(context.conversations, reminders)],
        ownerRoutes: [createReminderOwnerRoutes(reminders)],
        scheduledTasks: [
          createReminderScheduledWorkflow({
            clock: config.REMINDER_CLOCK,
            database: context.database,
            reminders
          })
        ]
      }),
      toolAdapters: [createReminderToolAdapter(reminders)]
    }
  }
}
