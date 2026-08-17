import type { CoreDatabase, DatabaseQuery } from "@bob/db-types"
import type { DeliveryTargetAdapter } from "@bob/delivery-service/target-adapter"

import { operationalAlerts } from "@bob/db-service/schema/alerts"
import { shortReplyBindings } from "@bob/db-service/schema/conversations"
import { reminderOccurrences } from "@bob/db-service/schema/reminders"
import { and, eq, inArray, isNull } from "drizzle-orm"
import { Effect } from "effect"

export function makeReminderDeliveryTarget(
  database: CoreDatabase,
  randomUuid: () => string = () => crypto.randomUUID()
): DeliveryTargetAdapter {
  return {
    targetType: "reminder_occurrence",
    async statements(event) {
      if (event.outcome === "accepted") {
        const [occurrence] = await Effect.runPromise(
          database
            .select({
              responseDeadlineAt: reminderOccurrences.responseDeadlineAt,
              state: reminderOccurrences.state
            })
            .from(reminderOccurrences)
            .where(eq(reminderOccurrences.id, event.targetId))
            .limit(1)
        )
        if (
          occurrence?.responseDeadlineAt === null ||
          occurrence?.responseDeadlineAt === undefined ||
          occurrence.state !== "awaiting_delivery" ||
          Date.parse(occurrence.responseDeadlineAt) <= Date.parse(event.occurredAt)
        ) {
          return []
        }
        return [
          database
            .update(reminderOccurrences)
            .set({ state: "awaiting_response", updatedAt: event.occurredAt })
            .where(
              and(
                eq(reminderOccurrences.id, event.targetId),
                eq(reminderOccurrences.state, "awaiting_delivery")
              )
            ),
          ...(["seen", "done"] as const).map((command) =>
            database
              .insert(shortReplyBindings)
              .values({
                id: randomUuid(),
                userId: event.ownerId,
                outboundMessageId: event.messageId,
                command,
                targetType: "reminder",
                targetId: event.targetId,
                expiresAt: occurrence.responseDeadlineAt!,
                createdAt: event.occurredAt
              })
              .onConflictDoNothing()
          )
        ]
      }
      const terminalState = event.outcome === "failed" ? "missed" : "cancelled"
      const allowedStates =
        event.outcome === "failed"
          ? (["awaiting_delivery", "awaiting_response"] as const)
          : (["claimed", "awaiting_delivery"] as const)
      const statements: DatabaseQuery[] = [
        database
          .update(reminderOccurrences)
          .set({ state: terminalState, updatedAt: event.occurredAt })
          .where(
            and(
              eq(reminderOccurrences.id, event.targetId),
              inArray(reminderOccurrences.state, allowedStates)
            )
          ),
        database
          .update(shortReplyBindings)
          .set({ consumedAt: event.occurredAt })
          .where(
            and(
              eq(shortReplyBindings.targetType, "reminder"),
              eq(shortReplyBindings.targetId, event.targetId),
              isNull(shortReplyBindings.consumedAt)
            )
          )
      ]
      if (event.outcome === "failed") {
        statements.push(
          database
            .insert(operationalAlerts)
            .values({
              id: randomUuid(),
              userId: event.ownerId,
              code: "reminder_missed",
              objectType: "reminder_occurrence",
              objectId: event.targetId,
              idempotencyKey: `alert:reminder-delivery-failed:${event.targetId}`,
              state: "open",
              createdAt: event.occurredAt,
              updatedAt: event.occurredAt
            })
            .onConflictDoNothing()
        )
      }
      return statements
    }
  }
}
