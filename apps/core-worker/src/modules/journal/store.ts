import type { JournalEntry, JournalMetadata } from "@bob/contracts/ui"
import type { BatchItem } from "drizzle-orm/batch"

import { and, desc, eq, gt, inArray, isNull, like } from "drizzle-orm"
import { Context, Layer, Schema } from "effect"

import type { CoreDatabase } from "../../database.ts"
import type { DataProtection } from "../policy/data-protection.ts"

import { users } from "../conversations/schema.ts"
import {
  factEvidence,
  factRevisions,
  facts,
  memoryCandidates,
  searchDocuments
} from "../memory/schema.ts"
import {
  completeEffect,
  completedEffect,
  completedEffectAfterConflict,
  type EffectIdentity
} from "../policy/effect-outcome.ts"
import { journalEntries, journalHandoffs } from "./schema.ts"

export interface JournalStore {
  createHandoff(
    ownerId: string,
    ttlMs: number,
    idempotencyKey: string
  ): Promise<{ id: string; expiresAt: string }>
  createEntry(
    input: {
      ownerId: string
      handoffId: string
      text: string
      tags: readonly string[]
      approvedSummary?: string
    },
    idempotencyKey: string
  ): Promise<string>
  searchMetadata(ownerId: string, tag?: string): Promise<readonly JournalMetadata[]>
  readEntry(ownerId: string, entryId: string): Promise<JournalEntry | undefined>
  updateEntry(
    ownerId: string,
    entryId: string,
    input: {
      readonly text: string
      readonly tags: readonly string[]
      readonly approvedSummary?: string
    },
    idempotencyKey: string
  ): Promise<void>
  deleteEntry(ownerId: string, entryId: string, idempotencyKey: string): Promise<void>
}

export const JournalStore = Context.Service<JournalStore>("bob/JournalStore")

const journalSourceTypes = ["journal", "journal_entry", "journal_summary"] as const
const JournalTags = Schema.Array(Schema.String)

export function makeJournalStore(
  database: CoreDatabase,
  protection: DataProtection,
  options: { readonly now?: () => Date; readonly randomUuid?: () => string }
): JournalStore {
  const now = options.now ?? (() => new Date())
  const randomUuid = options.randomUuid ?? (() => crypto.randomUUID())

  async function ownerKey(ownerId: string): Promise<{ key: CryptoKey; version: number }> {
    const [owner] = await database.select().from(users).where(eq(users.id, ownerId)).limit(1)
    if (
      owner?.wrappedDataKey === null ||
      owner?.wrappedDataKey === undefined ||
      owner.wrappedDataKeyIv === null ||
      owner.wrappedDataKeyIv === undefined ||
      owner.dataKeyVersion === null ||
      owner.dataKeyVersion === undefined
    ) {
      throw new Error("Owner data key is unavailable")
    }
    return {
      key: await protection.unwrapDataKey({
        ciphertext: owner.wrappedDataKey,
        iv: owner.wrappedDataKeyIv,
        version: owner.dataKeyVersion
      }),
      version: owner.dataKeyVersion
    }
  }

  return {
    async createHandoff(ownerId, ttlMs, idempotencyKey) {
      const effect: EffectIdentity = { ownerId, kind: "journal_handoff_create", idempotencyKey }
      const previous = await completedEffect(database, effect)
      if (previous !== undefined) {
        const [handoff] = await database
          .select({ id: journalHandoffs.id, expiresAt: journalHandoffs.expiresAt })
          .from(journalHandoffs)
          .where(eq(journalHandoffs.id, previous))
          .limit(1)
        if (handoff === undefined) throw new Error("The prior journal handoff is unavailable")
        return handoff
      }
      const id = randomUuid()
      const createdAt = now()
      const expiresAt = new Date(createdAt.getTime() + ttlMs).toISOString()
      try {
        await database.batch([
          database.insert(journalHandoffs).values({
            id,
            userId: ownerId,
            expiresAt,
            createdAt: createdAt.toISOString()
          }),
          completeEffect(database, effect, id, randomUuid(), createdAt.toISOString())
        ])
      } catch (error) {
        const winner = await completedEffectAfterConflict(database, effect, error)
        const [handoff] = await database
          .select({ id: journalHandoffs.id, expiresAt: journalHandoffs.expiresAt })
          .from(journalHandoffs)
          .where(eq(journalHandoffs.id, winner))
          .limit(1)
        if (handoff === undefined) throw new Error("The prior journal handoff is unavailable")
        return handoff
      }
      return { id, expiresAt }
    },

    async createEntry(input, idempotencyKey) {
      const effect: EffectIdentity = {
        ownerId: input.ownerId,
        kind: "journal_entry_create",
        idempotencyKey
      }
      const previous = await completedEffect(database, effect)
      if (previous !== undefined) return previous
      const at = now().toISOString()
      const [handoff] = await database
        .select({ id: journalHandoffs.id })
        .from(journalHandoffs)
        .where(
          and(
            eq(journalHandoffs.id, input.handoffId),
            eq(journalHandoffs.userId, input.ownerId),
            isNull(journalHandoffs.consumedAt),
            gt(journalHandoffs.expiresAt, at)
          )
        )
        .limit(1)
      if (handoff === undefined) throw new Error("Journal handoff is invalid or expired")
      const owner = await ownerKey(input.ownerId)
      const encrypted = await protection.encryptText(owner.key, input.text)
      const entryId = randomUuid()
      const contentHash = await protection.contentHash(input.text)
      const statements = [
        database.insert(journalEntries).values({
          id: entryId,
          userId: input.ownerId,
          handoffId: input.handoffId,
          textCiphertext: encrypted.ciphertext,
          textIv: encrypted.iv,
          dataKeyVersion: owner.version,
          tagsJson: JSON.stringify(input.tags),
          approvedSummary: input.approvedSummary,
          contentHash,
          createdAt: at
        })
      ] as const
      const consumeHandoff = database
        .update(journalHandoffs)
        .set({ consumedAt: at })
        .where(
          and(
            eq(journalHandoffs.id, input.handoffId),
            eq(journalHandoffs.userId, input.ownerId),
            isNull(journalHandoffs.consumedAt),
            gt(journalHandoffs.expiresAt, at)
          )
        )
      if (input.approvedSummary !== undefined) {
        try {
          await database.batch([
            ...statements,
            database.insert(searchDocuments).values({
              id: randomUuid(),
              userId: input.ownerId,
              sourceType: "journal_summary",
              sourceId: entryId,
              text: input.approvedSummary,
              sourceLabel: `journal ${at.slice(0, 10)}`,
              occurredAt: at,
              importance: 300,
              sensitivity: "private",
              modelEligible: false,
              channelEligible: false,
              createdAt: at,
              updatedAt: at
            }),
            consumeHandoff,
            completeEffect(database, effect, entryId, randomUuid(), at)
          ])
        } catch (error) {
          return completedEffectAfterConflict(database, effect, error)
        }
      } else {
        try {
          await database.batch([
            ...statements,
            consumeHandoff,
            completeEffect(database, effect, entryId, randomUuid(), at)
          ])
        } catch (error) {
          return completedEffectAfterConflict(database, effect, error)
        }
      }
      return entryId
    },

    async searchMetadata(ownerId, tag) {
      const rows = await database
        .select({
          id: journalEntries.id,
          createdAt: journalEntries.createdAt,
          tagsJson: journalEntries.tagsJson,
          approvedSummary: journalEntries.approvedSummary
        })
        .from(journalEntries)
        .where(
          and(
            eq(journalEntries.userId, ownerId),
            isNull(journalEntries.redactedAt),
            ...(tag === undefined
              ? []
              : [like(journalEntries.tagsJson, `%"${tag.replaceAll('"', "")}"%`)])
          )
        )
        .orderBy(desc(journalEntries.createdAt))
        .limit(100)
      return rows.map((row) => {
        const metadata = {
          id: row.id,
          createdAt: row.createdAt,
          tags: Schema.decodeUnknownSync(JournalTags)(JSON.parse(row.tagsJson))
        }
        return row.approvedSummary === null
          ? metadata
          : { ...metadata, approvedSummary: row.approvedSummary }
      })
    },

    async readEntry(ownerId, entryId) {
      const [row] = await database
        .select()
        .from(journalEntries)
        .where(
          and(
            eq(journalEntries.id, entryId),
            eq(journalEntries.userId, ownerId),
            isNull(journalEntries.redactedAt)
          )
        )
        .limit(1)
      if (row === undefined) return undefined
      const key = (await ownerKey(ownerId)).key
      const entry = {
        id: row.id,
        createdAt: row.createdAt,
        tags: Schema.decodeUnknownSync(JournalTags)(JSON.parse(row.tagsJson)),
        text: await protection.decryptText(key, {
          ciphertext: row.textCiphertext,
          iv: row.textIv
        })
      }
      return row.approvedSummary === null
        ? entry
        : { ...entry, approvedSummary: row.approvedSummary }
    },

    async updateEntry(ownerId, entryId, input, idempotencyKey) {
      const effect: EffectIdentity = { ownerId, kind: "journal_entry_update", idempotencyKey }
      if ((await completedEffect(database, effect)) !== undefined) return
      const [entry] = await database
        .select({ id: journalEntries.id, createdAt: journalEntries.createdAt })
        .from(journalEntries)
        .where(
          and(
            eq(journalEntries.id, entryId),
            eq(journalEntries.userId, ownerId),
            isNull(journalEntries.redactedAt)
          )
        )
        .limit(1)
      if (entry === undefined) throw new Error("Journal entry not found")
      const text = input.text.trim()
      if (text.length === 0 || text.length > 8_000) throw new Error("Journal text is invalid")
      const approvedSummary = input.approvedSummary?.trim()
      if (
        approvedSummary !== undefined &&
        (approvedSummary.length === 0 || approvedSummary.length > 1_200)
      ) {
        throw new Error("Approved summary is invalid")
      }
      const tags = [...new Set(input.tags.map((tag) => tag.trim()))]
      if (tags.length > 25 || tags.some((tag) => tag.length === 0 || tag.length > 1_200)) {
        throw new Error("Journal tags are invalid")
      }
      const at = now().toISOString()
      const owner = await ownerKey(ownerId)
      const [encrypted, contentHash, existingProjection] = await Promise.all([
        protection.encryptText(owner.key, text),
        protection.contentHash(text),
        database
          .select({ id: searchDocuments.id })
          .from(searchDocuments)
          .where(
            and(
              eq(searchDocuments.sourceType, "journal_summary"),
              eq(searchDocuments.sourceId, entryId)
            )
          )
          .limit(1)
      ])
      const sourcedRevisions = await database
        .select({ revisionId: factEvidence.revisionId, factId: factRevisions.factId })
        .from(factEvidence)
        .innerJoin(factRevisions, eq(factEvidence.revisionId, factRevisions.id))
        .innerJoin(facts, eq(factRevisions.factId, facts.id))
        .where(
          and(
            inArray(factEvidence.sourceType, journalSourceTypes),
            eq(factEvidence.sourceId, entryId),
            eq(facts.userId, ownerId)
          )
        )
      const unsupported: { revisionId: string; factId: string }[] = []
      for (const sourced of sourcedRevisions) {
        const evidence = await database
          .select({
            sourceType: factEvidence.sourceType,
            sourceId: factEvidence.sourceId,
            evidenceRole: factEvidence.evidenceRole
          })
          .from(factEvidence)
          .where(eq(factEvidence.revisionId, sourced.revisionId))
        const hasOtherEvidence = evidence.some(
          (item) =>
            item.evidenceRole === "supports" &&
            (!journalSourceTypes.some((sourceType) => sourceType === item.sourceType) ||
              item.sourceId !== entryId)
        )
        if (!hasOtherEvidence) unsupported.push(sourced)
      }
      const statements: [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]] = [
        database
          .update(journalEntries)
          .set({
            textCiphertext: encrypted.ciphertext,
            textIv: encrypted.iv,
            dataKeyVersion: owner.version,
            tagsJson: JSON.stringify(tags),
            approvedSummary: approvedSummary ?? null,
            contentHash
          })
          .where(
            and(
              eq(journalEntries.id, entryId),
              eq(journalEntries.userId, ownerId),
              isNull(journalEntries.redactedAt)
            )
          ),
        database
          .update(memoryCandidates)
          .set({ status: "rejected", reviewedAt: at })
          .where(
            and(
              eq(memoryCandidates.userId, ownerId),
              inArray(memoryCandidates.sourceType, journalSourceTypes),
              eq(memoryCandidates.sourceId, entryId),
              inArray(memoryCandidates.status, ["proposed", "disputed"])
            )
          ),
        database
          .delete(factEvidence)
          .where(
            and(
              inArray(factEvidence.sourceType, journalSourceTypes),
              eq(factEvidence.sourceId, entryId)
            )
          )
      ]
      if (approvedSummary === undefined) {
        statements.push(
          database
            .update(searchDocuments)
            .set({ text: "", deletedAt: at, updatedAt: at })
            .where(
              and(
                eq(searchDocuments.sourceType, "journal_summary"),
                eq(searchDocuments.sourceId, entryId)
              )
            )
        )
      } else if (existingProjection[0] === undefined) {
        statements.push(
          database.insert(searchDocuments).values({
            id: randomUuid(),
            userId: ownerId,
            sourceType: "journal_summary",
            sourceId: entryId,
            text: approvedSummary,
            sourceLabel: `journal ${entry.createdAt.slice(0, 10)}`,
            occurredAt: entry.createdAt,
            importance: 300,
            sensitivity: "private",
            modelEligible: false,
            channelEligible: false,
            createdAt: at,
            updatedAt: at
          })
        )
      } else {
        statements.push(
          database
            .update(searchDocuments)
            .set({
              text: approvedSummary,
              modelEligible: false,
              channelEligible: false,
              deletedAt: null,
              updatedAt: at
            })
            .where(eq(searchDocuments.id, existingProjection[0].id))
        )
      }
      for (const item of unsupported) {
        statements.push(
          database
            .update(factRevisions)
            .set({ verificationStatus: "disputed", modelEligible: false, channelEligible: false })
            .where(eq(factRevisions.id, item.revisionId)),
          database
            .update(facts)
            .set({ currentRevisionId: null })
            .where(and(eq(facts.id, item.factId), eq(facts.currentRevisionId, item.revisionId))),
          database
            .update(searchDocuments)
            .set({
              text: "",
              modelEligible: false,
              channelEligible: false,
              deletedAt: at,
              updatedAt: at
            })
            .where(
              and(
                eq(searchDocuments.sourceType, "fact_revision"),
                eq(searchDocuments.sourceId, item.revisionId)
              )
            )
        )
      }
      statements.push(completeEffect(database, effect, entryId, randomUuid(), at))
      try {
        await database.batch(statements)
      } catch (error) {
        await completedEffectAfterConflict(database, effect, error)
      }
    },

    async deleteEntry(ownerId, entryId, idempotencyKey) {
      const effect: EffectIdentity = { ownerId, kind: "journal_entry_delete", idempotencyKey }
      if ((await completedEffect(database, effect)) !== undefined) return
      const at = now().toISOString()
      const [entry] = await database
        .select({ id: journalEntries.id })
        .from(journalEntries)
        .where(and(eq(journalEntries.id, entryId), eq(journalEntries.userId, ownerId)))
        .limit(1)
      if (entry === undefined) {
        await database.batch([completeEffect(database, effect, entryId, randomUuid(), at)])
        return
      }
      const sourcedRevisions = await database
        .select({ revisionId: factEvidence.revisionId, factId: factRevisions.factId })
        .from(factEvidence)
        .innerJoin(factRevisions, eq(factEvidence.revisionId, factRevisions.id))
        .innerJoin(facts, eq(factRevisions.factId, facts.id))
        .where(
          and(
            inArray(factEvidence.sourceType, journalSourceTypes),
            eq(factEvidence.sourceId, entryId),
            eq(facts.userId, ownerId)
          )
        )
      const unsupported: { revisionId: string; factId: string }[] = []
      for (const sourced of sourcedRevisions) {
        const evidence = await database
          .select({
            sourceType: factEvidence.sourceType,
            sourceId: factEvidence.sourceId,
            evidenceRole: factEvidence.evidenceRole
          })
          .from(factEvidence)
          .where(eq(factEvidence.revisionId, sourced.revisionId))
        const hasOtherEvidence = evidence.some(
          (item) =>
            item.evidenceRole === "supports" &&
            (!journalSourceTypes.some((sourceType) => sourceType === item.sourceType) ||
              item.sourceId !== entryId)
        )
        if (!hasOtherEvidence) unsupported.push(sourced)
      }
      const tombstone = await protection.encryptText((await ownerKey(ownerId)).key, "[deleted]")
      const statements: [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]] = [
        database
          .update(journalEntries)
          .set({
            textCiphertext: tombstone.ciphertext,
            textIv: tombstone.iv,
            tagsJson: "[]",
            approvedSummary: null,
            redactedAt: at
          })
          .where(and(eq(journalEntries.id, entryId), eq(journalEntries.userId, ownerId))),
        database
          .update(searchDocuments)
          .set({ text: "", deletedAt: at, updatedAt: at })
          .where(
            and(
              eq(searchDocuments.sourceType, "journal_summary"),
              eq(searchDocuments.sourceId, entryId)
            )
          ),
        database
          .delete(memoryCandidates)
          .where(
            and(
              eq(memoryCandidates.userId, ownerId),
              inArray(memoryCandidates.sourceType, journalSourceTypes),
              eq(memoryCandidates.sourceId, entryId)
            )
          ),
        database
          .delete(factEvidence)
          .where(
            and(
              inArray(factEvidence.sourceType, journalSourceTypes),
              eq(factEvidence.sourceId, entryId)
            )
          )
      ]
      for (const item of unsupported) {
        statements.push(
          database
            .update(factRevisions)
            .set({ verificationStatus: "disputed", modelEligible: false, channelEligible: false })
            .where(eq(factRevisions.id, item.revisionId)),
          database
            .update(facts)
            .set({ currentRevisionId: null })
            .where(and(eq(facts.id, item.factId), eq(facts.currentRevisionId, item.revisionId))),
          database
            .update(searchDocuments)
            .set({
              text: "",
              modelEligible: false,
              channelEligible: false,
              deletedAt: at,
              updatedAt: at
            })
            .where(
              and(
                eq(searchDocuments.sourceType, "fact_revision"),
                eq(searchDocuments.sourceId, item.revisionId)
              )
            )
        )
      }
      statements.push(completeEffect(database, effect, entryId, randomUuid(), at))
      try {
        await database.batch(statements)
      } catch (error) {
        await completedEffectAfterConflict(database, effect, error)
      }
    }
  }
}

export function journalStoreLayer(store: JournalStore) {
  return Layer.succeed(JournalStore, store)
}
