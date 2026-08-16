import type { JournalEntry, JournalMetadata } from "@bob/contracts/ui/journal"

import { journalEntries, journalHandoffs } from "@bob/db/schema/journal"
import { searchDocuments } from "@bob/db/schema/retrieval"
import { and, desc, eq, gt, isNull, sql } from "drizzle-orm"
import { Context, Layer, Schema } from "effect"

import type { CoreBatchQuery, CoreDatabase } from "../../database.ts"
import type { DataProtection } from "../policy/data-protection.ts"
import type { OwnerDataKeyStore } from "../policy/owner-data-key.ts"
import type { RetrievalProjectionInput } from "../retrieval/projection.ts"

import { prepareMemorySourceWithdrawal } from "../memory/source-withdrawal.ts"
import {
  completeEffect,
  completedEffect,
  completedEffectAfterConflict,
  type EffectIdentity
} from "../policy/effect-outcome.ts"
import { makeOwnerDataKeyStore } from "../policy/owner-data-key.ts"
import { retrievalProjection } from "../retrieval/projection.ts"

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

interface NormalizedJournalEntry {
  readonly text: string
  readonly tags: readonly string[]
  readonly approvedSummary?: string
}

function normalizeJournalEntry(input: {
  readonly text: string
  readonly tags: readonly string[]
  readonly approvedSummary?: string
}): NormalizedJournalEntry {
  const text = input.text.trim()
  if (text.length === 0 || text.length > 8_000) throw new Error("Journal text is invalid")

  const tags = [...new Set(input.tags.map((tag) => tag.trim()).filter((tag) => tag.length > 0))]
  if (tags.length > 25 || tags.some((tag) => tag.length > 1_200)) {
    throw new Error("Journal tags are invalid")
  }

  const approvedSummary = input.approvedSummary?.trim()
  if (
    approvedSummary !== undefined &&
    (approvedSummary.length === 0 || approvedSummary.length > 1_200)
  ) {
    throw new Error("Approved summary is invalid")
  }

  return approvedSummary === undefined ? { text, tags } : { text, tags, approvedSummary }
}

function normalizeJournalTag(tag: string): string {
  const normalized = tag.trim()
  if (normalized.length === 0 || normalized.length > 1_200) {
    throw new Error("Journal tag is invalid")
  }
  return normalized
}

export function makeJournalStore(
  database: CoreDatabase,
  protection: DataProtection,
  options: {
    readonly now?: () => Date
    readonly randomUuid?: () => string
    readonly ownerDataKeys?: OwnerDataKeyStore
  }
): JournalStore {
  const now = options.now ?? (() => new Date())
  const randomUuid = options.randomUuid ?? (() => crypto.randomUUID())
  const ownerDataKeys =
    options.ownerDataKeys ??
    makeOwnerDataKeyStore(database, protection, { defaultTimeZone: "UTC", now })

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
      const normalized = normalizeJournalEntry(input)
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
      const owner = await ownerDataKeys.load(input.ownerId)
      const encrypted = await protection.encryptText(owner.key, normalized.text)
      const entryId = randomUuid()
      const contentHash = await protection.contentHash(normalized.text)
      const summaryContentHash =
        normalized.approvedSummary === undefined
          ? undefined
          : await protection.contentHash(normalized.approvedSummary)
      const statements = [
        database.insert(journalEntries).values({
          id: entryId,
          userId: input.ownerId,
          handoffId: input.handoffId,
          textCiphertext: encrypted.ciphertext,
          textIv: encrypted.iv,
          dataKeyVersion: owner.version,
          tagsJson: JSON.stringify(normalized.tags),
          approvedSummary: normalized.approvedSummary,
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
      if (normalized.approvedSummary !== undefined) {
        const projectionInput: RetrievalProjectionInput = {
          id: randomUuid(),
          ownerId: input.ownerId,
          sourceType: "journal_summary",
          sourceId: entryId,
          memoryClass: "owner_episode",
          text: normalized.approvedSummary,
          searchText: `${normalized.tags.join(" ")} ${normalized.approvedSummary}`,
          sourceLabel: `journal ${at.slice(0, 10)}`,
          occurredAt: at,
          validFrom: at,
          importance: 300,
          sensitivity: "private",
          modelEligible: false,
          channelEligible: false,
          createdAt: at
        }
        if (summaryContentHash !== undefined) {
          Object.assign(projectionInput, { contentHash: summaryContentHash })
        }
        try {
          await database.batch([
            ...statements,
            database.insert(searchDocuments).values(retrievalProjection(projectionInput)),
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
      const normalizedTag = tag === undefined ? undefined : normalizeJournalTag(tag)
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
            ...(normalizedTag === undefined
              ? []
              : [
                  sql<boolean>`exists (
                    select 1
          from jsonb_array_elements_text(${journalEntries.tagsJson}::jsonb) as journal_tag(value)
                    where journal_tag.value = ${normalizedTag}
                  )`
                ])
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
      const key = (await ownerDataKeys.load(ownerId)).key
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
      const { text, tags, approvedSummary } = normalizeJournalEntry(input)
      const at = now().toISOString()
      const owner = await ownerDataKeys.load(ownerId)
      const [encrypted, contentHash, summaryContentHash, existingProjection] = await Promise.all([
        protection.encryptText(owner.key, text),
        protection.contentHash(text),
        approvedSummary === undefined
          ? Promise.resolve(undefined)
          : protection.contentHash(approvedSummary),
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
      const memoryStatements = await prepareMemorySourceWithdrawal(database, {
        ownerId,
        sourceTypes: journalSourceTypes,
        sourceId: entryId,
        reason: "source_changed",
        at
      })
      const statements: [CoreBatchQuery, ...CoreBatchQuery[]] = [
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
        ...memoryStatements
      ]
      if (approvedSummary === undefined) {
        statements.push(
          database
            .update(searchDocuments)
            .set({ text: "", searchText: "", contentHash: null, deletedAt: at, updatedAt: at })
            .where(
              and(
                eq(searchDocuments.sourceType, "journal_summary"),
                eq(searchDocuments.sourceId, entryId)
              )
            )
        )
      } else if (existingProjection[0] === undefined) {
        const projectionInput: RetrievalProjectionInput = {
          id: randomUuid(),
          ownerId,
          sourceType: "journal_summary",
          sourceId: entryId,
          memoryClass: "owner_episode",
          text: approvedSummary,
          searchText: `${tags.join(" ")} ${approvedSummary}`,
          sourceLabel: `journal ${entry.createdAt.slice(0, 10)}`,
          occurredAt: entry.createdAt,
          validFrom: entry.createdAt,
          importance: 300,
          sensitivity: "private",
          modelEligible: false,
          channelEligible: false,
          createdAt: at
        }
        if (summaryContentHash !== undefined) {
          Object.assign(projectionInput, { contentHash: summaryContentHash })
        }
        statements.push(
          database.insert(searchDocuments).values(retrievalProjection(projectionInput))
        )
      } else {
        statements.push(
          database
            .update(searchDocuments)
            .set({
              text: approvedSummary,
              searchText: `${tags.join(" ")} ${approvedSummary}`,
              contentHash: summaryContentHash,
              modelEligible: false,
              channelEligible: false,
              deletedAt: null,
              updatedAt: at
            })
            .where(eq(searchDocuments.id, existingProjection[0].id))
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
      const [tombstone, memoryStatements] = await Promise.all([
        ownerDataKeys.load(ownerId).then(({ key }) => protection.encryptText(key, "[deleted]")),
        prepareMemorySourceWithdrawal(database, {
          ownerId,
          sourceTypes: journalSourceTypes,
          sourceId: entryId,
          reason: "source_deleted",
          at
        })
      ])
      const statements: [CoreBatchQuery, ...CoreBatchQuery[]] = [
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
          .set({ text: "", searchText: "", contentHash: null, deletedAt: at, updatedAt: at })
          .where(
            and(
              eq(searchDocuments.sourceType, "journal_summary"),
              eq(searchDocuments.sourceId, entryId)
            )
          ),
        ...memoryStatements
      ]
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
