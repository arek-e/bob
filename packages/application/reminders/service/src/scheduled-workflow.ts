import type { ScheduledTaskModule } from "@bob/core-types/runtime-module"
import type { CoreDatabase } from "@bob/db-types"

import { schedulerOutbox } from "@bob/db-service/schema/reminders"
import { withBobSpan, injectCurrentTraceparent } from "@bob/observability"
import { and, eq, isNull } from "drizzle-orm"
import { Effect } from "effect"

import type { ReminderStore } from "./store.ts"

export function makeReminderScheduledWorkflow(input: {
  readonly clock: {
    readonly fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
  }
  readonly database: CoreDatabase
  readonly reminders: ReminderStore
  readonly ownerId: string
}): ScheduledTaskModule {
  return {
    id: "reminder-scheduler",
    async run(context) {
      const failures: unknown[] = []
      async function recover(operation: () => Promise<void>) {
        try {
          await operation()
        } catch (error) {
          failures.push(error)
        }
      }
      const startedAt = new Date().toISOString()
      await recover(async () => {
        await input.reminders.releaseExpiredClaims(startedAt)
      })
      await recover(async () => {
        await input.reminders.markExpiredResponseDeadlines(startedAt)
      })

      const clock = input.clock
      const clockBaseUrl = `https://reminder-clock.internal/owners/${encodeURIComponent(input.ownerId)}`
      const pending = await Effect.runPromise(
        input.database
          .select()
          .from(schedulerOutbox)
          .where(isNull(schedulerOutbox.processedAt))
          .orderBy(schedulerOutbox.createdAt)
          .limit(100)
      )
      for (const item of pending) {
        await recover(async () => {
          const response = await context.runPromise(
            withBobSpan(
              {
                name: "bob.reminder.invoke",
                correlationId: context.correlationId,
                feature: "reminders"
              },
              Effect.gen(function* () {
                const headers = yield* injectCurrentTraceparent({
                  "content-type": "application/json",
                  "x-bob-correlation-id": context.correlationId
                })
                return yield* Effect.promise(() =>
                  clock.fetch(`${clockBaseUrl}/command`, {
                    method: "POST",
                    headers,
                    body: JSON.stringify({
                      id: item.id,
                      reminderId: item.reminderId,
                      scheduleRevision: item.scheduleRevision,
                      command: item.command
                    })
                  })
                )
              })
            )
          )
          if (!response.ok) throw new Error("reminder_clock_command_failed")
          await Effect.runPromise(
            input.database
              .update(schedulerOutbox)
              .set({ processedAt: new Date().toISOString() })
              .where(and(eq(schedulerOutbox.id, item.id), isNull(schedulerOutbox.processedAt)))
          )
        })
      }

      await recover(async () => {
        const response = await context.runPromise(
          withBobSpan(
            {
              name: "bob.reminder.invoke",
              correlationId: context.correlationId,
              feature: "reminders"
            },
            Effect.gen(function* () {
              const headers = yield* injectCurrentTraceparent({
                "x-bob-correlation-id": context.correlationId
              })
              return yield* Effect.promise(() =>
                clock.fetch(`${clockBaseUrl}/reconcile`, { method: "POST", headers })
              )
            })
          )
        )
        if (!response.ok) throw new Error("reminder_clock_reconcile_failed")
      })
      if (failures.length > 0) throw new Error("reminder_scheduled_workflow_failed")
    }
  }
}
