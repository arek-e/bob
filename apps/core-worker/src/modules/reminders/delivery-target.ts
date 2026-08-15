import type { BatchItem } from "drizzle-orm/batch"

import { and, eq, inArray, isNull } from "drizzle-orm"

import type { CoreDatabase } from "../../database.ts"
import type { DeliveryTargetAdapter } from "../delivery/target-adapter.ts"

import { operationalAlerts } from "../alerts/schema.ts"
import { shortReplyBindings } from "../conversations/schema.ts"
import { reminderOccurrences } from "./schema.ts"

export function makeReminderDeliveryTarget(
  database: CoreDatabase,
  randomUuid: () => string = () => crypto.randomUUID()
): DeliveryTargetAdapter {
  return {
    targetType: "reminder_occurrence",
    async statements(event) {
      if (event.outcome === "accepted") {
        const [occurrence] = await database
          .select({
            responseDeadlineAt: reminderOccurrences.responseDeadlineAt,
            state: reminderOccurrences.state
          })
          .from(reminderOccurrences)
          .where(eq(reminderOccurrences.id, event.targetId))
          .limit(1)
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
      const statements: BatchItem<"sqlite">[] = [
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
