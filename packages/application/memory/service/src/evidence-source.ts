import type { PrivateTextReader } from "@bob/context-service/private-text"
import type { CoreDatabase } from "@bob/db-types"
import type { DataProtection } from "@bob/policy-types/data-protection"

import { factRevisions, facts } from "@bob/db-service/schema/memory"
import { and, eq } from "drizzle-orm"
import { Effect } from "effect"

import type { EvidenceSourceAdapter } from "./evidence.ts"

export function makeFactEvidenceSource(
  database: CoreDatabase,
  text: PrivateTextReader,
  protection: DataProtection
): EvidenceSourceAdapter {
  return {
    id: "owner_fact_evidence",
    sourceTypes: ["fact_revision"],
    async verify(reference) {
      const [record] = await Effect.runPromise(
        database
          .select({
            observedAt: factRevisions.observedAt,
            ciphertext: factRevisions.canonicalTextCiphertext,
            iv: factRevisions.canonicalTextIv,
            sensitivity: factRevisions.sensitivity
          })
          .from(factRevisions)
          .innerJoin(facts, eq(facts.id, factRevisions.factId))
          .where(
            and(
              eq(factRevisions.id, reference.sourceId),
              eq(facts.userId, reference.ownerId),
              eq(factRevisions.verificationStatus, "confirmed")
            )
          )
          .limit(1)
      )
      if (record === undefined) return undefined
      const contentHash = await protection.contentHash(
        await text.decrypt(reference.ownerId, {
          ciphertext: record.ciphertext,
          iv: record.iv
        })
      )
      return {
        sourceLabel: `Confirmed fact linked on ${record.observedAt.slice(0, 10)}`,
        occurredAt: record.observedAt,
        contentHash,
        originClass: "recalled_content",
        sensitivity: record.sensitivity,
        confirmationAuthority: "never",
        disclosure: "private"
      }
    }
  }
}
