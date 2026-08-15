import { and, asc, desc, eq, isNull } from "drizzle-orm"

import type { CoreDatabase } from "../../database.ts"
import type { PrivateTextReader } from "../context/private-text.ts"
import type { ContextSourceModule } from "../context/source.ts"
import type { MemoryRecall } from "./store.ts"

import { approvedContextItem } from "../context/source.ts"
import { factEvidence, factRevisions, facts } from "./schema.ts"

function sourceDay(value: string | null | undefined): string {
  return value?.slice(0, 10) ?? "date unknown"
}

export function makeMemoryContextSources(
  database: CoreDatabase,
  memory: MemoryRecall,
  text: PrivateTextReader,
  options: {
    readonly profileCharacterBudget?: number
    readonly retrievalCharacterBudget?: number
    readonly retrievalLimit?: number
  } = {}
): readonly ContextSourceModule[] {
  const profileCharacterBudget = options.profileCharacterBudget ?? 3_600
  const retrievalCharacterBudget = options.retrievalCharacterBudget ?? 2_400
  const retrievalLimit = options.retrievalLimit ?? 8
  const profile: ContextSourceModule = {
    id: "profile",
    async load(input) {
      const rows = await database
        .select({
          revision: factRevisions,
          sourceType: factEvidence.sourceType,
          sourceId: factEvidence.sourceId
        })
        .from(facts)
        .innerJoin(factRevisions, eq(facts.currentRevisionId, factRevisions.id))
        .leftJoin(
          factEvidence,
          and(
            eq(factEvidence.revisionId, factRevisions.id),
            eq(factEvidence.evidenceRole, "supports")
          )
        )
        .where(
          and(
            eq(facts.userId, input.ownerId),
            eq(factRevisions.verificationStatus, "confirmed"),
            eq(factRevisions.modelEligible, true),
            eq(factRevisions.channelEligible, true),
            isNull(factRevisions.validTo)
          )
        )
        .orderBy(desc(factRevisions.importance), asc(factRevisions.createdAt))
      const candidates = []
      const seen = new Set<string>()
      let used = 0
      for (const row of rows) {
        if (seen.has(row.revision.id)) continue
        seen.add(row.revision.id)
        const value = await text.decrypt(input.ownerId, {
          ciphertext: row.revision.canonicalTextCiphertext,
          iv: row.revision.canonicalTextIv
        })
        if (used + value.length > profileCharacterBudget) continue
        used += value.length
        candidates.push(
          approvedContextItem({
            kind: "profile",
            text: value,
            instruction: false,
            conflict: false,
            sources: [
              {
                sourceId: row.sourceId ?? row.revision.id,
                sourceLabel: `${row.sourceType ?? "fact"} ${sourceDay(row.revision.observedAt)}`,
                occurredAt: row.revision.observedAt
              }
            ]
          })
        )
      }
      return candidates
    }
  }

  const lexical: ContextSourceModule = {
    id: "lexical",
    deduplicateAgainst: ["inline_reply", "profile", "conversation", "artifact"],
    async load(input) {
      const rows = await memory.search(input.ownerId, input.currentUserText, true)
      const candidates = []
      let used = 0
      for (const row of rows) {
        if (used + row.text.length > retrievalCharacterBudget) continue
        used += row.text.length
        candidates.push(
          approvedContextItem({
            kind: "record",
            text: row.text,
            instruction: false,
            conflict: false,
            sources: [
              row.occurredAt === undefined
                ? { sourceId: row.sourceId, sourceLabel: row.sourceLabel }
                : {
                    sourceId: row.sourceId,
                    sourceLabel: row.sourceLabel,
                    occurredAt: row.occurredAt
                  }
            ]
          })
        )
        if (candidates.length >= retrievalLimit) break
      }
      return candidates
    }
  }
  return Object.freeze([profile, lexical])
}
