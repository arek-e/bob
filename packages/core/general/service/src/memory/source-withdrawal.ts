import type { CoreBatchQuery, CoreDatabase } from "@bob/core-types/database"

import { factEvidence, factRevisions, facts, memoryCandidates } from "@bob/db-service/schema/memory"
import { searchDocuments } from "@bob/db-service/schema/retrieval"
import { and, eq, inArray, sql, type SQL } from "drizzle-orm"

export interface MemorySourceWithdrawal {
  readonly ownerId: string
  readonly sourceTypes: readonly [string, ...string[]]
  readonly sourceId: string
  readonly reason: "source_changed" | "source_deleted"
  readonly at: string
}

/**
 * Prepares Memory-owned mutations for a source change.
 *
 * The caller must include every returned statement in the same PostgreSQL transaction.
 */
export async function prepareMemorySourceWithdrawal(
  database: CoreDatabase,
  withdrawal: MemorySourceWithdrawal
): Promise<readonly CoreBatchQuery[]> {
  const sourceTypes = sql.join(
    withdrawal.sourceTypes.map((sourceType) => sql`${sourceType}`),
    sql`, `
  )
  const ownedRevision = (revisionId: SQL) => sql`
    EXISTS (
      SELECT 1
      FROM fact_revisions AS owned_revision
      INNER JOIN facts AS owned_fact ON owned_fact.id = owned_revision.fact_id
      WHERE owned_revision.id = ${revisionId}
        AND owned_fact.user_id = ${withdrawal.ownerId}
    )
  `
  const invalidatedRevision = (revisionId: SQL) => sql`
    ${ownedRevision(revisionId)}
    AND EXISTS (
      SELECT 1
      FROM fact_evidence AS withdrawn_evidence
      WHERE withdrawn_evidence.revision_id = ${revisionId}
        AND withdrawn_evidence.source_type IN (${sourceTypes})
        AND withdrawn_evidence.source_id = ${withdrawal.sourceId}
    )
    AND NOT EXISTS (
      SELECT 1
      FROM fact_evidence AS remaining_evidence
      WHERE remaining_evidence.revision_id = ${revisionId}
        AND remaining_evidence.evidence_role = 'supports'
        AND NOT (
          remaining_evidence.source_type IN (${sourceTypes})
          AND remaining_evidence.source_id = ${withdrawal.sourceId}
        )
    )
  `

  return [
    withdrawal.reason === "source_changed"
      ? database
          .update(memoryCandidates)
          .set({
            status: "rejected",
            reviewedAt: withdrawal.at,
            reviewClaimAction: null,
            reviewClaimId: null,
            reviewClaimExpiresAt: null,
            reviewResultId: null
          })
          .where(
            and(
              eq(memoryCandidates.userId, withdrawal.ownerId),
              inArray(memoryCandidates.sourceType, withdrawal.sourceTypes),
              eq(memoryCandidates.sourceId, withdrawal.sourceId),
              inArray(memoryCandidates.status, ["proposed", "disputed", "claimed"])
            )
          )
      : database
          .delete(memoryCandidates)
          .where(
            and(
              eq(memoryCandidates.userId, withdrawal.ownerId),
              inArray(memoryCandidates.sourceType, withdrawal.sourceTypes),
              eq(memoryCandidates.sourceId, withdrawal.sourceId)
            )
          ),
    database
      .update(factRevisions)
      .set({ verificationStatus: "disputed", modelEligible: false, channelEligible: false })
      .where(invalidatedRevision(sql`${factRevisions.id}`)),
    database
      .update(facts)
      .set({ currentRevisionId: null })
      .where(
        and(
          eq(facts.userId, withdrawal.ownerId),
          sql`${facts.currentRevisionId} IS NOT NULL`,
          invalidatedRevision(sql`${facts.currentRevisionId}`)
        )
      ),
    database
      .update(searchDocuments)
      .set({
        text: "",
        searchText: "",
        contentHash: null,
        modelEligible: false,
        channelEligible: false,
        deletedAt: withdrawal.at,
        updatedAt: withdrawal.at
      })
      .where(
        and(
          eq(searchDocuments.sourceType, "fact_revision"),
          invalidatedRevision(sql`${searchDocuments.sourceId}`)
        )
      ),
    database
      .delete(factEvidence)
      .where(
        and(
          inArray(factEvidence.sourceType, withdrawal.sourceTypes),
          eq(factEvidence.sourceId, withdrawal.sourceId),
          ownedRevision(sql`${factEvidence.revisionId}`)
        )
      )
  ]
}
