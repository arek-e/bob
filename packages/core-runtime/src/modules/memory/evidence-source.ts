import { factRevisions, facts } from "@bob/db/schema/memory"
import { and, eq } from "drizzle-orm"

import type { CoreDatabase } from "../../database.ts"
import type { PrivateTextReader } from "../context/private-text.ts"
import type { DataProtection } from "../policy/data-protection.ts"
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
      const [record] = await database
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
