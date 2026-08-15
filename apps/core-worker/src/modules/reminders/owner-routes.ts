import { ReminderSnoozeRequest } from "@bob/contracts/ui/reminders"
import { Schema } from "effect"

import type { OwnerRouteModule } from "../runtime/module.ts"
import type { ReminderStore } from "./store.ts"

export function makeReminderOwnerRoutes(reminders: ReminderStore): OwnerRouteModule {
  return {
    id: "reminder-owner-routes",
    async handle(context) {
      const { request, url, ownerId } = context
      if (request.method === "GET" && url.pathname === "/api/reminders") {
        return { body: { reminders: await reminders.list(ownerId) } }
      }
      const occurrence = url.pathname.match(
        /^\/api\/reminder-occurrences\/([^/]+)\/(seen|done|snooze)$/
      )
      if (request.method === "POST" && occurrence !== null) {
        const occurrenceId = decodeURIComponent(occurrence[1]!)
        const action = occurrence[2]!
        const key = context.idempotencyKey()
        if (action === "seen") await reminders.acknowledge(ownerId, occurrenceId, key)
        else if (action === "done") await reminders.complete(ownerId, occurrenceId, key)
        else {
          const input = Schema.decodeUnknownSync(ReminderSnoozeRequest)(await context.readJson())
          if (Date.parse(input.dueAt) <= Date.now()) throw new Error("Snooze time must be future")
          return {
            body: {
              successorOccurrenceId: await reminders.snooze(ownerId, occurrenceId, input.dueAt, key)
            }
          }
        }
        return { body: { ok: true } }
      }
      const cancel = url.pathname.match(/^\/api\/reminders\/([^/]+)\/cancel$/)
      if (request.method !== "POST" || cancel === null) return undefined
      await reminders.cancel(
        ownerId,
        decodeURIComponent(cancel[1]!),
        undefined,
        context.idempotencyKey()
      )
      return { body: { ok: true } }
    }
  }
}
