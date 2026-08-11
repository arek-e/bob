import { and, desc, eq, isNull, sql } from "drizzle-orm"
import type { BatchItem } from "drizzle-orm/batch"
import { Context, Layer } from "effect"

import type { CoreDatabase } from "../../database.ts"
import { messages, users } from "../conversations/schema.ts"
import { journalEntries } from "../journal/schema.ts"
import type { DataProtection } from "../policy/data-protection.ts"
import {
  completeEffect,
  completedEffect,
  completedEffectAfterConflict,
  type EffectIdentity
} from "../policy/effect-outcome.ts"
import { reminders } from "../reminders/schema.ts"
import { routines, workoutSessions } from "../training/schema.ts"
import { canPromoteOrigin, decideCandidate, deriveMemoryPolicy, type OriginClass } from "./rules.ts"
import {
  factEvidence,
  factRelations,
  factRevisions,
  facts,
  memoryCandidates,
  searchDocuments
} from "./schema.ts"

export interface MemoryProposal {
  readonly ownerId: string
  readonly scope: string
  readonly key: string
  readonly value: unknown
  readonly canonicalText: string
  readonly assertionKind: "user_stated" | "system_recorded" | "inferred"
  readonly originClass: OriginClass
  readonly sourceType: string
  readonly sourceId: string
  readonly extractionConfidence: number
  readonly importance: number
  readonly explicitRemember: boolean
  readonly authority: "agent" | "owner_deterministic" | "completed_system_command"
}

export interface MemorySearchResult {
  readonly id: string
  readonly text: string
  readonly sourceLabel: string
  readonly occurredAt?: string
}

export interface MemoryCandidateReview {
  readonly id: string
  readonly scope: string
  readonly key: string
  readonly value: unknown
  readonly canonicalText: string
  readonly originClass: OriginClass
  readonly sourceType: string
  readonly sourceId: string
  readonly sensitivity: "normal" | "private" | "high"
  readonly status: "proposed" | "disputed"
  readonly createdAt: string
}

export interface MemoryStore {
  propose(
    input: MemoryProposal,
    idempotencyKey: string
  ): Promise<{ candidateId: string; status: string }>
  confirm(
    ownerId: string,
    candidateId: string,
    authority: "owner_ui" | "completed_system_command",
    idempotencyKey: string
  ): Promise<string>
  listCandidates(ownerId: string): Promise<readonly MemoryCandidateReview[]>
  search(ownerId: string, query: string, channel: boolean): Promise<readonly MemorySearchResult[]>
}

export const MemoryStore = Context.Service<MemoryStore>("bob/MemoryStore")

export function makeMemoryStore(
  database: CoreDatabase,
  protection: DataProtection,
  options: { readonly now?: () => Date; readonly randomUuid?: () => string }
): MemoryStore {
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

  async function validateEvidence(candidate: typeof memoryCandidates.$inferSelect): Promise<void> {
    let evidence: readonly { id: string }[]
    switch (candidate.sourceType) {
      case "message":
        if (candidate.originClass !== "owner_input")
          throw new Error("Memory evidence source type does not match its origin")
        evidence = await database
          .select({ id: messages.id })
          .from(messages)
          .where(
            and(
              eq(messages.id, candidate.sourceId),
              eq(messages.userId, candidate.userId),
              eq(messages.direction, "inbound")
            )
          )
          .limit(1)
        break
      case "journal":
      case "journal_entry":
      case "journal_summary":
        if (candidate.originClass !== "owner_input")
          throw new Error("Memory evidence source type does not match its origin")
        evidence = await database
          .select({ id: journalEntries.id })
          .from(journalEntries)
          .where(
            and(
              eq(journalEntries.id, candidate.sourceId),
              eq(journalEntries.userId, candidate.userId),
              isNull(journalEntries.redactedAt)
            )
          )
          .limit(1)
        break
      case "reminder":
        if (candidate.originClass !== "system_record")
          throw new Error("Memory evidence source type does not match its origin")
        evidence = await database
          .select({ id: reminders.id })
          .from(reminders)
          .where(and(eq(reminders.id, candidate.sourceId), eq(reminders.userId, candidate.userId)))
          .limit(1)
        break
      case "routine":
        if (candidate.originClass !== "system_record")
          throw new Error("Memory evidence source type does not match its origin")
        evidence = await database
          .select({ id: routines.id })
          .from(routines)
          .where(and(eq(routines.id, candidate.sourceId), eq(routines.userId, candidate.userId)))
          .limit(1)
        break
      case "workout_session":
        if (candidate.originClass !== "system_record")
          throw new Error("Memory evidence source type does not match its origin")
        evidence = await database
          .select({ id: workoutSessions.id })
          .from(workoutSessions)
          .where(
            and(
              eq(workoutSessions.id, candidate.sourceId),
              eq(workoutSessions.userId, candidate.userId)
            )
          )
          .limit(1)
        break
      default:
        throw new Error("Memory evidence source type is not supported")
    }
    if (evidence[0] === undefined) throw new Error("Memory evidence does not exist for the owner")
  }

  return {
    async propose(input, idempotencyKey) {
      const effect: EffectIdentity = {
        ownerId: input.ownerId,
        kind: "memory_propose",
        idempotencyKey
      }
      const previous = await completedEffect(database, effect)
      if (previous !== undefined) {
        const [candidate] = await database
          .select({ status: memoryCandidates.status })
          .from(memoryCandidates)
          .where(eq(memoryCandidates.id, previous))
          .limit(1)
        if (candidate === undefined) throw new Error("The prior memory proposal is unavailable")
        return { candidateId: previous, status: candidate.status }
      }
      const policy = deriveMemoryPolicy(input)
      const owner = await ownerKey(input.ownerId)
      const [current] = await database
        .select({ revisionId: facts.currentRevisionId })
        .from(facts)
        .where(
          and(
            eq(facts.userId, input.ownerId),
            eq(facts.scope, input.scope),
            eq(facts.key, input.key)
          )
        )
        .limit(1)
      let conflictsWithConfirmed = false
      if (current?.revisionId !== null && current?.revisionId !== undefined) {
        const [revision] = await database
          .select({
            valueJson: factRevisions.valueJson,
            valueCiphertext: factRevisions.valueCiphertext,
            valueIv: factRevisions.valueIv
          })
          .from(factRevisions)
          .where(eq(factRevisions.id, current.revisionId))
          .limit(1)
        const currentValue =
          revision?.valueCiphertext !== null &&
          revision?.valueCiphertext !== undefined &&
          revision.valueIv !== null
            ? await protection.decryptText(owner.key, {
                ciphertext: revision.valueCiphertext,
                iv: revision.valueIv
              })
            : revision?.valueJson
        conflictsWithConfirmed = currentValue !== JSON.stringify(input.value)
      }
      const status = decideCandidate({
        assertionKind: input.assertionKind,
        originClass: input.originClass,
        sensitive: policy.sensitivity !== "normal",
        highImpact: policy.sensitivity === "high",
        explicitRemember:
          input.explicitRemember &&
          (input.authority === "owner_deterministic" ||
            input.authority === "completed_system_command"),
        conflictsWithConfirmed
      })
      const encrypted = await protection.encryptText(owner.key, input.canonicalText)
      const serializedValue = JSON.stringify(input.value)
      const encryptedValue =
        policy.sensitivity === "normal"
          ? undefined
          : await protection.encryptText(owner.key, serializedValue)
      const candidateId = randomUuid()
      const createdAt = now().toISOString()
      try {
        await database.batch([
          database.insert(memoryCandidates).values({
            id: candidateId,
            userId: input.ownerId,
            scope: input.scope,
            key: input.key,
            proposedValueJson: encryptedValue === undefined ? serializedValue : "null",
            proposedValueCiphertext: encryptedValue?.ciphertext,
            proposedValueIv: encryptedValue?.iv,
            canonicalTextCiphertext: encrypted.ciphertext,
            canonicalTextIv: encrypted.iv,
            originClass: input.originClass,
            sourceType: input.sourceType,
            sourceId: input.sourceId,
            extractionConfidence: Math.round(input.extractionConfidence * 1_000),
            sensitivity: policy.sensitivity,
            status,
            createdAt,
            ...(status === "confirmed" ? { reviewedAt: createdAt } : {})
          }),
          completeEffect(database, effect, candidateId, randomUuid(), createdAt)
        ])
      } catch (error) {
        const winner = await completedEffectAfterConflict(database, effect, error)
        const [candidate] = await database
          .select({ status: memoryCandidates.status })
          .from(memoryCandidates)
          .where(eq(memoryCandidates.id, winner))
          .limit(1)
        if (candidate === undefined) throw new Error("The prior memory proposal is unavailable")
        return { candidateId: winner, status: candidate.status }
      }
      if (status === "confirmed") {
        await this.confirm(
          input.ownerId,
          candidateId,
          input.authority === "completed_system_command" ? "completed_system_command" : "owner_ui",
          `${idempotencyKey}:confirm`
        )
      }
      return { candidateId, status }
    },

    async confirm(ownerId, candidateId, authority, idempotencyKey) {
      const [candidate] = await database
        .select()
        .from(memoryCandidates)
        .where(and(eq(memoryCandidates.id, candidateId), eq(memoryCandidates.userId, ownerId)))
        .limit(1)
      if (candidate === undefined) throw new Error("Memory candidate not found")
      const effect: EffectIdentity = {
        ownerId,
        kind: "memory_confirm",
        idempotencyKey
      }
      const previous = await completedEffect(database, effect)
      if (previous !== undefined) return previous
      if (!canPromoteOrigin(candidate.originClass as OriginClass)) {
        throw new Error("This memory origin cannot confirm a fact")
      }
      if (
        (candidate.originClass === "owner_input" && authority !== "owner_ui") ||
        (candidate.originClass === "system_record" && authority !== "completed_system_command")
      ) {
        throw new Error("This caller cannot confirm the memory candidate")
      }
      await validateEvidence(candidate)
      let [fact] = await database
        .select()
        .from(facts)
        .where(
          and(
            eq(facts.userId, candidate.userId),
            eq(facts.scope, candidate.scope),
            eq(facts.key, candidate.key)
          )
        )
        .limit(1)
      if (fact === undefined) {
        const factId = randomUuid()
        await database
          .insert(facts)
          .values({
            id: factId,
            userId: candidate.userId,
            scope: candidate.scope,
            key: candidate.key,
            createdAt: now().toISOString()
          })
          .onConflictDoNothing()
        ;[fact] = await database
          .select()
          .from(facts)
          .where(
            and(
              eq(facts.userId, candidate.userId),
              eq(facts.scope, candidate.scope),
              eq(facts.key, candidate.key)
            )
          )
          .limit(1)
      }
      if (fact === undefined) throw new Error("Fact identity creation failed")
      const owner = await ownerKey(candidate.userId)
      const canonicalText = await protection.decryptText(owner.key, {
        ciphertext: candidate.canonicalTextCiphertext,
        iv: candidate.canonicalTextIv
      })
      const revisionId = randomUuid()
      const createdAt = now().toISOString()
      const excerptHash = await protection.contentHash(canonicalText)
      const sensitiveValue =
        candidate.proposedValueCiphertext === null || candidate.proposedValueIv === null
          ? undefined
          : {
              ciphertext: candidate.proposedValueCiphertext,
              iv: candidate.proposedValueIv
            }
      const previousRevisionId = fact.currentRevisionId
      const statements: [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]] = [
        database.insert(factRevisions).values({
          id: revisionId,
          factId: fact.id,
          valueJson: sensitiveValue === undefined ? candidate.proposedValueJson : "null",
          valueCiphertext: sensitiveValue?.ciphertext,
          valueIv: sensitiveValue?.iv,
          canonicalTextCiphertext: candidate.canonicalTextCiphertext,
          canonicalTextIv: candidate.canonicalTextIv,
          dataKeyVersion: owner.version,
          assertionKind:
            candidate.originClass === "system_record" ? "system_recorded" : "user_stated",
          originClass: candidate.originClass as OriginClass,
          observedAt: candidate.createdAt,
          extractionConfidence: candidate.extractionConfidence,
          importance: 500,
          verificationStatus: "confirmed" as const,
          sensitivity: candidate.sensitivity as "normal" | "private" | "high",
          modelEligible: candidate.sensitivity === "normal",
          channelEligible: candidate.sensitivity === "normal",
          supersedesRevisionId: previousRevisionId,
          createdAt
        }),
        database.insert(factEvidence).values({
          id: randomUuid(),
          revisionId,
          sourceType: candidate.sourceType,
          sourceId: candidate.sourceId,
          evidenceRole: "supports" as const,
          excerptHash,
          createdAt
        }),
        database.update(facts).set({ currentRevisionId: revisionId }).where(eq(facts.id, fact.id)),
        database
          .update(memoryCandidates)
          .set({ status: "confirmed" as const, reviewedAt: createdAt })
          .where(eq(memoryCandidates.id, candidate.id))
      ]
      if (candidate.sensitivity === "normal") {
        statements.push(
          database.insert(searchDocuments).values({
            id: randomUuid(),
            userId: candidate.userId,
            sourceType: "fact_revision",
            sourceId: revisionId,
            text: canonicalText,
            sourceLabel: `${candidate.sourceType} ${candidate.createdAt.slice(0, 10)}`,
            occurredAt: candidate.createdAt,
            importance: 500,
            sensitivity: candidate.sensitivity,
            modelEligible: candidate.sensitivity === "normal",
            channelEligible: candidate.sensitivity === "normal",
            createdAt,
            updatedAt: createdAt
          })
        )
      }
      if (previousRevisionId !== null) {
        statements.push(
          database
            .update(factRevisions)
            .set({ verificationStatus: "superseded", validTo: createdAt })
            .where(eq(factRevisions.id, previousRevisionId)),
          database.insert(factRelations).values({
            id: randomUuid(),
            fromRevisionId: revisionId,
            toRevisionId: previousRevisionId,
            relation: "supersedes",
            createdAt
          })
        )
      }
      statements.push(completeEffect(database, effect, revisionId, randomUuid(), createdAt))
      try {
        await database.batch(statements)
      } catch (error) {
        return completedEffectAfterConflict(database, effect, error)
      }
      return revisionId
    },

    async listCandidates(ownerId) {
      const rows = await database
        .select()
        .from(memoryCandidates)
        .where(
          and(
            eq(memoryCandidates.userId, ownerId),
            sql`${memoryCandidates.status} IN ('proposed', 'disputed')`
          )
        )
        .orderBy(desc(memoryCandidates.createdAt))
        .limit(50)
      if (rows.length === 0) return []
      const owner = await ownerKey(ownerId)
      return Promise.all(
        rows.map(async (candidate) => {
          const canonicalText = await protection.decryptText(owner.key, {
            ciphertext: candidate.canonicalTextCiphertext,
            iv: candidate.canonicalTextIv
          })
          const serializedValue =
            candidate.proposedValueCiphertext === null || candidate.proposedValueIv === null
              ? candidate.proposedValueJson
              : await protection.decryptText(owner.key, {
                  ciphertext: candidate.proposedValueCiphertext,
                  iv: candidate.proposedValueIv
                })
          return {
            id: candidate.id,
            scope: candidate.scope,
            key: candidate.key,
            value: JSON.parse(serializedValue) as unknown,
            canonicalText,
            originClass: candidate.originClass as OriginClass,
            sourceType: candidate.sourceType,
            sourceId: candidate.sourceId,
            sensitivity: candidate.sensitivity as "normal" | "private" | "high",
            status: candidate.status as "proposed" | "disputed",
            createdAt: candidate.createdAt
          }
        })
      )
    },

    async search(ownerId, query, channel) {
      const rows = await database.all<{
        document_id: string
        text: string
        source_label: string
        occurred_at: string | null
      }>(sql`
        SELECT f.document_id, f.text, f.source_label, d.occurred_at
        FROM search_documents_fts AS f
        JOIN search_documents AS d ON d.id = f.document_id
        WHERE search_documents_fts MATCH ${query}
          AND f.user_id = ${ownerId}
          AND d.deleted_at IS NULL
          AND d.model_eligible = 1
          AND (${channel ? 1 : 0} = 0 OR d.channel_eligible = 1)
        ORDER BY bm25(search_documents_fts), d.importance DESC
        LIMIT 12
      `)
      return rows.map((row) => ({
        id: row.document_id,
        text: row.text,
        sourceLabel: row.source_label,
        ...(row.occurred_at === null ? {} : { occurredAt: row.occurred_at })
      }))
    }
  }
}

export function memoryStoreLayer(store: MemoryStore) {
  return Layer.succeed(MemoryStore, store)
}
