import { applyD1Migrations, reset } from "cloudflare:test"
import { env } from "cloudflare:workers"
import { eq } from "drizzle-orm"
import { beforeEach, describe, expect, it } from "vitest"

import { createCoreDatabase } from "../src/database.ts"
import {
  factEvidence,
  factRevisions,
  facts,
  memoryCandidates
} from "../src/modules/memory/schema.ts"
import { prepareMemorySourceWithdrawal } from "../src/modules/memory/source-withdrawal.ts"
import { searchDocuments } from "../src/modules/retrieval/schema.ts"
import { decodeTestMigrations } from "./migrations.ts"

declare global {
  namespace Cloudflare {
    interface Env {
      DB: D1Database
      TEST_MIGRATIONS: string
    }
  }
}

const ownerId = "owner-one"
const sourceId = "journal-one"
const at = "2026-08-16T10:00:00.000Z"
const journalSourceTypes = ["journal", "journal_entry", "journal_summary"] as const

function candidate(id: string, status: "proposed" | "confirmed") {
  return {
    id,
    userId: ownerId,
    scope: "journal",
    key: id,
    proposedValueEnvelope: JSON.stringify({ version: 1, kind: "plain", value: id }),
    canonicalTextCiphertext: "ciphertext",
    canonicalTextIv: "iv",
    memoryClass: "owner_fact" as const,
    originClass: "owner_input",
    sourceType: "journal_summary",
    sourceId,
    extractionConfidence: 1_000,
    sensitivity: "normal",
    status,
    createdAt: at
  }
}

function revision(id: string, factId: string) {
  return {
    id,
    factId,
    valueEnvelope: JSON.stringify({ version: 1, kind: "plain", value: id }),
    canonicalTextCiphertext: "ciphertext",
    canonicalTextIv: "iv",
    dataKeyVersion: 1,
    assertionKind: "user_stated" as const,
    originClass: "owner_input" as const,
    observedAt: at,
    extractionConfidence: 1_000,
    importance: 500,
    verificationStatus: "confirmed" as const,
    sensitivity: "normal" as const,
    modelEligible: true,
    channelEligible: true,
    createdAt: at
  }
}

function projection(id: string, revisionId: string) {
  return {
    id,
    userId: ownerId,
    sourceType: "fact_revision",
    sourceId: revisionId,
    memoryClass: "owner_fact" as const,
    text: revisionId,
    searchText: revisionId,
    sourceLabel: "journal",
    importance: 500,
    sensitivity: "normal" as const,
    modelEligible: true,
    channelEligible: true,
    createdAt: at,
    updatedAt: at
  }
}

async function apply(statements: Awaited<ReturnType<typeof prepareMemorySourceWithdrawal>>) {
  const [first, ...remaining] = statements
  if (first === undefined) throw new Error("Memory source withdrawal returned no statements")
  await createCoreDatabase(env.DB).batch([first, ...remaining])
}

beforeEach(async () => {
  await reset()
  await applyD1Migrations(env.DB, decodeTestMigrations(env.TEST_MIGRATIONS))
})

describe("Memory source withdrawal", () => {
  it("withdraws aliases and preserves a revision with other supporting evidence", async () => {
    const database = createCoreDatabase(env.DB)
    await database.batch([
      database.insert(facts).values([
        {
          id: "unsupported-fact",
          userId: ownerId,
          scope: "journal",
          key: "unsupported",
          currentRevisionId: "unsupported-revision",
          createdAt: at
        },
        {
          id: "supported-fact",
          userId: ownerId,
          scope: "journal",
          key: "supported",
          currentRevisionId: "supported-revision",
          createdAt: at
        }
      ]),
      database
        .insert(factRevisions)
        .values([
          revision("unsupported-revision", "unsupported-fact"),
          revision("supported-revision", "supported-fact")
        ]),
      database.insert(factEvidence).values([
        {
          id: "unsupported-source",
          revisionId: "unsupported-revision",
          sourceType: "journal_entry",
          sourceId,
          evidenceRole: "supports",
          excerptHash: "hash-one",
          createdAt: at
        },
        {
          id: "unsupported-contradiction",
          revisionId: "unsupported-revision",
          sourceType: "message",
          sourceId: "message-one",
          evidenceRole: "contradicts",
          excerptHash: "hash-two",
          createdAt: at
        },
        {
          id: "supported-source",
          revisionId: "supported-revision",
          sourceType: "journal_summary",
          sourceId,
          evidenceRole: "supports",
          excerptHash: "hash-three",
          createdAt: at
        },
        {
          id: "supported-alternative",
          revisionId: "supported-revision",
          sourceType: "message",
          sourceId: "message-two",
          evidenceRole: "supports",
          excerptHash: "hash-four",
          createdAt: at
        }
      ]),
      database
        .insert(searchDocuments)
        .values([
          projection("unsupported-document", "unsupported-revision"),
          projection("supported-document", "supported-revision")
        ]),
      database
        .insert(memoryCandidates)
        .values([
          candidate("pending-candidate", "proposed"),
          candidate("settled-candidate", "confirmed")
        ])
    ])

    await apply(
      await prepareMemorySourceWithdrawal(database, {
        ownerId,
        sourceTypes: journalSourceTypes,
        sourceId,
        reason: "source_changed",
        at
      })
    )

    await expect(database.select().from(facts)).resolves.toEqual([
      expect.objectContaining({ id: "unsupported-fact", currentRevisionId: null }),
      expect.objectContaining({
        id: "supported-fact",
        currentRevisionId: "supported-revision"
      })
    ])
    await expect(database.select().from(factRevisions)).resolves.toEqual([
      expect.objectContaining({ id: "unsupported-revision", verificationStatus: "disputed" }),
      expect.objectContaining({ id: "supported-revision", verificationStatus: "confirmed" })
    ])
    await expect(database.select().from(factEvidence)).resolves.toEqual([
      expect.objectContaining({ id: "unsupported-contradiction" }),
      expect.objectContaining({ id: "supported-alternative" })
    ])
    await expect(database.select().from(searchDocuments)).resolves.toEqual([
      expect.objectContaining({ id: "unsupported-document", text: "", deletedAt: at }),
      expect.objectContaining({ id: "supported-document", text: "supported-revision" })
    ])
    await expect(database.select().from(memoryCandidates)).resolves.toEqual([
      expect.objectContaining({ id: "pending-candidate", status: "rejected", reviewedAt: at }),
      expect.objectContaining({ id: "settled-candidate", status: "confirmed" })
    ])
  })

  it("deletes all candidates when their source is deleted", async () => {
    const database = createCoreDatabase(env.DB)
    await database
      .insert(memoryCandidates)
      .values([
        candidate("pending-candidate", "proposed"),
        candidate("settled-candidate", "confirmed")
      ])

    await apply(
      await prepareMemorySourceWithdrawal(database, {
        ownerId,
        sourceTypes: journalSourceTypes,
        sourceId,
        reason: "source_deleted",
        at
      })
    )

    await expect(database.select().from(memoryCandidates)).resolves.toEqual([])
  })

  it.each(["source_changed", "source_deleted"] as const)(
    "withdraws an in-flight confirmation that completes before a %s batch",
    async (reason) => {
      const database = createCoreDatabase(env.DB)
      const candidateId = `in-flight-${reason}`
      const revisionId = `reserved-${reason}`
      await database.insert(memoryCandidates).values({
        ...candidate(candidateId, "proposed"),
        status: "claimed",
        reviewClaimAction: "confirm",
        reviewClaimId: `claim-${reason}`,
        reviewClaimExpiresAt: "2026-08-16T10:01:00.000Z",
        reviewResultId: revisionId
      })
      const statements = await prepareMemorySourceWithdrawal(database, {
        ownerId,
        sourceTypes: journalSourceTypes,
        sourceId,
        reason,
        at
      })

      await database.batch([
        database.insert(facts).values({
          id: `fact-${reason}`,
          userId: ownerId,
          scope: "journal",
          key: reason,
          currentRevisionId: revisionId,
          createdAt: at
        }),
        database.insert(factRevisions).values(revision(revisionId, `fact-${reason}`)),
        database.insert(factEvidence).values({
          id: `evidence-${reason}`,
          revisionId,
          sourceType: "journal_summary",
          sourceId,
          evidenceRole: "supports",
          excerptHash: `hash-${reason}`,
          createdAt: at
        }),
        database.insert(searchDocuments).values(projection(`document-${reason}`, revisionId)),
        database
          .update(memoryCandidates)
          .set({
            status: "confirmed",
            reviewedAt: at,
            reviewClaimAction: null,
            reviewClaimId: null,
            reviewClaimExpiresAt: null,
            reviewResultId: null
          })
          .where(eq(memoryCandidates.id, candidateId))
      ])
      await apply(statements)

      await expect(database.select().from(facts)).resolves.toEqual([
        expect.objectContaining({ id: `fact-${reason}`, currentRevisionId: null })
      ])
      await expect(database.select().from(factRevisions)).resolves.toEqual([
        expect.objectContaining({ id: revisionId, verificationStatus: "disputed" })
      ])
      await expect(database.select().from(factEvidence)).resolves.toEqual([])
      await expect(database.select().from(searchDocuments)).resolves.toEqual([
        expect.objectContaining({ id: `document-${reason}`, text: "", deletedAt: at })
      ])
      const [remainingCandidate] = await database
        .select({ status: memoryCandidates.status })
        .from(memoryCandidates)
        .where(eq(memoryCandidates.id, candidateId))
      if (reason === "source_changed") expect(remainingCandidate?.status).toBe("confirmed")
      else expect(remainingCandidate).toBeUndefined()
    }
  )
})
