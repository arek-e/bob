import type { CoreDatabase } from "@bob/db-types"
import type { EvidenceSourceAdapter } from "@bob/memory-types/evidence"
import type { DataProtection } from "@bob/policy-types/data-protection"

import { journalEntries } from "@bob/db-service/schema/journal"
import { evidenceDate } from "@bob/memory-service/evidence"
import { and, eq, isNull } from "drizzle-orm"
import { Effect } from "effect"

export function makeJournalEvidenceSource(
  database: CoreDatabase,
  protection: DataProtection
): EvidenceSourceAdapter {
  return {
    id: "journal_evidence",
    sourceTypes: ["journal", "journal_entry", "journal_summary"],
    async verify(reference) {
      const [record] = await Effect.runPromise(
        database
          .select({
            createdAt: journalEntries.createdAt,
            contentHash: journalEntries.contentHash,
            approvedSummary: journalEntries.approvedSummary
          })
          .from(journalEntries)
          .where(
            and(
              eq(journalEntries.id, reference.sourceId),
              eq(journalEntries.userId, reference.ownerId),
              isNull(journalEntries.redactedAt)
            )
          )
          .limit(1)
      )
      if (record === undefined) return undefined
      if (reference.sourceType === "journal_summary" && record.approvedSummary === null) {
        return undefined
      }
      return {
        sourceLabel: `Journal entry linked on ${evidenceDate(record.createdAt)}`,
        occurredAt: record.createdAt,
        contentHash:
          reference.sourceType === "journal_summary"
            ? await protection.contentHash(record.approvedSummary!)
            : record.contentHash,
        originClass: "owner_input",
        sensitivity: "private",
        confirmationAuthority: "owner_ui",
        disclosure: "private"
      }
    }
  }
}
