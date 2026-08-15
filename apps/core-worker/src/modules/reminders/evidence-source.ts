import { and, eq } from "drizzle-orm"

import type { CoreDatabase } from "../../database.ts"
import type { EvidenceSourceAdapter } from "../memory/evidence.ts"
import type { DataProtection } from "../policy/data-protection.ts"

import { evidenceDate } from "../memory/evidence.ts"
import { reminderActions, reminders } from "./schema.ts"

export function makeReminderEvidenceSource(
  database: CoreDatabase,
  protection: DataProtection
): EvidenceSourceAdapter {
  return {
    id: "reminder_evidence",
    sourceTypes: ["reminder"],
    async verify(reference) {
      const [record] = await database
        .select({
          createdAt: reminders.createdAt,
          sensitivity: reminders.sensitivity,
          revision: reminders.scheduleRevision
        })
        .from(reminders)
        .innerJoin(
          reminderActions,
          and(eq(reminderActions.reminderId, reminders.id), eq(reminderActions.action, "created"))
        )
        .where(and(eq(reminders.id, reference.sourceId), eq(reminders.userId, reference.ownerId)))
        .limit(1)
      if (record === undefined) return undefined
      return {
        sourceLabel: `Saved reminder linked on ${evidenceDate(record.createdAt)}`,
        occurredAt: record.createdAt,
        contentHash: await protection.contentHash(
          `reminder:${reference.sourceId}:revision:${record.revision}`
        ),
        originClass: "system_record",
        sensitivity: record.sensitivity,
        confirmationAuthority: "completed_system_command",
        disclosure: record.sensitivity === "normal" ? "model_and_channel" : "private"
      }
    }
  }
}
