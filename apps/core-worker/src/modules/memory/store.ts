import type { BatchItem } from "drizzle-orm/batch"

import { and, desc, eq, sql } from "drizzle-orm"
import { Context, Layer, Schema } from "effect"

import type { CoreDatabase } from "../../database.ts"
import type { DataProtection } from "../policy/data-protection.ts"
import type { EvidenceSourceRegistry, MemoryClass } from "./evidence.ts"

import { users } from "../conversations/schema.ts"
import {
  completeEffect,
  completedEffect,
  completedEffectAfterConflict,
  type EffectIdentity
} from "../policy/effect-outcome.ts"
import { buildFtsQuery, rankRetrievalCandidates } from "./retrieval.ts"
import {
  canPromoteOrigin,
  decideCandidate,
  deriveConfirmedMemoryPolicy,
  deriveMemoryPolicy,
  type OriginClass
} from "./rules.ts"
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
  readonly sourceType: string
  readonly sourceId: string
  readonly extractionConfidence: number
  readonly importance: number
  readonly explicitRemember: boolean
  readonly authority: "agent" | "owner_deterministic" | "completed_system_command"
}

export interface MemorySearchResult {
  readonly id: string
  readonly sourceId: string
  readonly text: string
  readonly sourceLabel: string
  readonly memoryClass: MemoryClass
  readonly occurredAt?: string
}

export interface MemoryCandidateReview {
  readonly id: string
  readonly memoryClass: "owner_fact"
  readonly scope: string
  readonly key: string
  readonly value: unknown
  readonly canonicalText: string
  readonly originClass: OriginClass
  readonly sourceType: string
  readonly sourceId: string
  readonly sourceLabel: string
  readonly sensitivity: "normal" | "private" | "high"
  readonly status: "proposed" | "disputed"
  readonly createdAt: string
}

export interface OwnerFactStore {
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
  correct(
    ownerId: string,
    candidateId: string,
    canonicalText: string,
    idempotencyKey: string
  ): Promise<string>
  reject(ownerId: string, candidateId: string, idempotencyKey: string): Promise<void>
  listCandidates(ownerId: string): Promise<readonly MemoryCandidateReview[]>
}

export interface MemoryRecall {
  search(ownerId: string, query: string, channel: boolean): Promise<readonly MemorySearchResult[]>
}

export type MemoryStore = OwnerFactStore & MemoryRecall

export const MemoryStore = Context.Service<MemoryStore>("bob/MemoryStore")

const monthLabels = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec"
] as const

const OriginClassValue = Schema.Literals([
  "owner_input",
  "system_record",
  "recalled_content",
  "tool_output",
  "assistant_output",
  "background_model"
])
const MemorySensitivity = Schema.Literals(["normal", "private", "high"])
const CandidateStatus = Schema.Literals(["proposed", "disputed"])
const MemoryClassValue = Schema.Literals(["owner_fact", "owner_episode", "agent_experience"])

function legacyCandidateSourceLabel(createdAt: string): string {
  const [year = "", month = "", day = ""] = createdAt.slice(0, 10).split("-")
  const monthLabel = monthLabels[Number(month) - 1] ?? month
  const date = `${Number(day)} ${monthLabel} ${year}`
  return `Saved source linked on ${date}`
}

export function makeMemoryStore(
  database: CoreDatabase,
  protection: DataProtection,
  evidenceSources: EvidenceSourceRegistry,
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

  async function claimReview(
    candidate: typeof memoryCandidates.$inferSelect,
    status: "confirmed" | "rejected",
    reviewedAt: string
  ): Promise<boolean> {
    const [claimed] = await database
      .update(memoryCandidates)
      .set({ status, reviewedAt })
      .where(
        and(
          eq(memoryCandidates.id, candidate.id),
          eq(memoryCandidates.userId, candidate.userId),
          sql`${memoryCandidates.status} IN ('proposed', 'disputed')`
        )
      )
      .returning({ id: memoryCandidates.id })
    return claimed !== undefined
  }

  async function releaseReview(
    candidate: typeof memoryCandidates.$inferSelect,
    status: "confirmed" | "rejected",
    reviewedAt: string
  ): Promise<void> {
    await database
      .update(memoryCandidates)
      .set({ status: candidate.status, reviewedAt: candidate.reviewedAt })
      .where(
        and(
          eq(memoryCandidates.id, candidate.id),
          eq(memoryCandidates.userId, candidate.userId),
          eq(memoryCandidates.status, status),
          eq(memoryCandidates.reviewedAt, reviewedAt)
        )
      )
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
      const sourceEvidence = await evidenceSources.verify({
        ownerId: input.ownerId,
        sourceType: input.sourceType,
        sourceId: input.sourceId
      })
      const assertionKind =
        sourceEvidence.originClass === "owner_input"
          ? "user_stated"
          : sourceEvidence.originClass === "system_record"
            ? "system_recorded"
            : "inferred"
      const derivedPolicy = deriveMemoryPolicy({
        ...input,
        originClass: sourceEvidence.originClass
      })
      const sensitivity =
        sourceEvidence.sensitivity === "high" || derivedPolicy.sensitivity === "high"
          ? "high"
          : sourceEvidence.sensitivity === "private" || derivedPolicy.sensitivity === "private"
            ? "private"
            : "normal"
      const policy = {
        sensitivity,
        modelEligible:
          sensitivity === "normal" &&
          derivedPolicy.modelEligible &&
          sourceEvidence.disclosure === "model_and_channel",
        channelEligible:
          sensitivity === "normal" &&
          derivedPolicy.channelEligible &&
          sourceEvidence.disclosure === "model_and_channel"
      }
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
        assertionKind,
        originClass: sourceEvidence.originClass,
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
      const initialStatus = status === "confirmed" ? "proposed" : status
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
            memoryClass: "owner_fact",
            originClass: sourceEvidence.originClass,
            sourceType: input.sourceType,
            sourceId: input.sourceId,
            sourceLabel: sourceEvidence.sourceLabel,
            sourceOccurredAt: sourceEvidence.occurredAt,
            sourceContentHash: sourceEvidence.contentHash,
            extractionConfidence: Math.round(input.extractionConfidence * 1_000),
            sensitivity: policy.sensitivity,
            status: initialStatus,
            createdAt
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
      if (candidate.status !== "proposed" && candidate.status !== "disputed") {
        throw new Error("Memory candidate was already reviewed")
      }
      const originClass = Schema.decodeUnknownSync(OriginClassValue)(candidate.originClass)
      if (!canPromoteOrigin(originClass)) {
        throw new Error("This memory origin cannot confirm a fact")
      }
      if (
        (candidate.originClass === "owner_input" && authority !== "owner_ui") ||
        (candidate.originClass === "system_record" && authority !== "completed_system_command")
      ) {
        throw new Error("This caller cannot confirm the memory candidate")
      }
      const sourceEvidence = await evidenceSources.verify({
        ownerId: candidate.userId,
        sourceType: candidate.sourceType,
        sourceId: candidate.sourceId
      })
      if (
        sourceEvidence.originClass !== originClass ||
        (candidate.sourceContentHash !== null &&
          candidate.sourceContentHash !== sourceEvidence.contentHash)
      ) {
        throw new Error("Memory evidence changed after proposal")
      }
      if (sourceEvidence.confirmationAuthority !== authority) {
        throw new Error("This evidence source cannot confirm the memory candidate")
      }
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
      const excerptHash = sourceEvidence.contentHash
      const sensitiveValue =
        candidate.proposedValueCiphertext === null || candidate.proposedValueIv === null
          ? undefined
          : {
              ciphertext: candidate.proposedValueCiphertext,
              iv: candidate.proposedValueIv
            }
      const confirmedPolicy = deriveConfirmedMemoryPolicy({
        sensitivity: candidate.sensitivity === "high" ? "high" : sourceEvidence.sensitivity,
        disclosure: sourceEvidence.disclosure
      })
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
          originClass,
          observedAt: sourceEvidence.occurredAt ?? candidate.createdAt,
          extractionConfidence: candidate.extractionConfidence,
          importance: 500,
          verificationStatus: "confirmed" as const,
          sensitivity: confirmedPolicy.sensitivity,
          modelEligible: confirmedPolicy.modelEligible,
          channelEligible: confirmedPolicy.channelEligible,
          supersedesRevisionId: previousRevisionId,
          createdAt
        }),
        database.insert(factEvidence).values({
          id: randomUuid(),
          revisionId,
          sourceType: candidate.sourceType,
          sourceId: candidate.sourceId,
          sourceLabel: candidate.sourceLabel ?? sourceEvidence.sourceLabel,
          sourceOccurredAt: candidate.sourceOccurredAt ?? sourceEvidence.occurredAt,
          evidenceRole: "supports" as const,
          excerptHash,
          createdAt
        }),
        database.update(facts).set({ currentRevisionId: revisionId }).where(eq(facts.id, fact.id))
      ]
      if (confirmedPolicy.modelEligible) {
        statements.push(
          database.insert(searchDocuments).values({
            id: randomUuid(),
            userId: candidate.userId,
            sourceType: "fact_revision",
            sourceId: revisionId,
            memoryClass: "owner_fact",
            text: canonicalText,
            sourceLabel: candidate.sourceLabel ?? sourceEvidence.sourceLabel,
            occurredAt: sourceEvidence.occurredAt ?? candidate.createdAt,
            importance: 500,
            sensitivity: confirmedPolicy.sensitivity,
            modelEligible: confirmedPolicy.modelEligible,
            channelEligible: confirmedPolicy.channelEligible,
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
          database
            .update(searchDocuments)
            .set({ deletedAt: createdAt, updatedAt: createdAt })
            .where(
              and(
                eq(searchDocuments.sourceType, "fact_revision"),
                eq(searchDocuments.sourceId, previousRevisionId)
              )
            ),
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
      if (!(await claimReview(candidate, "confirmed", createdAt))) {
        const settled = await completedEffect(database, effect)
        if (settled !== undefined) return settled
        throw new Error("Memory candidate was already reviewed")
      }
      try {
        await database.batch(statements)
      } catch (error) {
        try {
          return await completedEffectAfterConflict(database, effect, error)
        } catch (settlementError) {
          await releaseReview(candidate, "confirmed", createdAt)
          throw settlementError
        }
      }
      return revisionId
    },

    async correct(ownerId, candidateId, canonicalText, idempotencyKey) {
      const effect: EffectIdentity = { ownerId, kind: "memory_correct", idempotencyKey }
      const previous = await completedEffect(database, effect)
      if (previous !== undefined) return previous
      const [candidate] = await database
        .select()
        .from(memoryCandidates)
        .where(and(eq(memoryCandidates.id, candidateId), eq(memoryCandidates.userId, ownerId)))
        .limit(1)
      if (candidate === undefined) throw new Error("Memory candidate not found")
      if (candidate.status !== "proposed" && candidate.status !== "disputed") {
        throw new Error("Memory candidate was already reviewed")
      }
      if (candidate.originClass !== "owner_input") {
        throw new Error("Only an owner statement can be corrected here")
      }
      const sourceEvidence = await evidenceSources.verify({
        ownerId: candidate.userId,
        sourceType: candidate.sourceType,
        sourceId: candidate.sourceId
      })
      if (
        sourceEvidence.originClass !== "owner_input" ||
        (candidate.sourceContentHash !== null &&
          candidate.sourceContentHash !== sourceEvidence.contentHash)
      ) {
        throw new Error("Memory evidence changed after proposal")
      }
      const trimmed = canonicalText.trim()
      if (trimmed.length === 0 || trimmed.length > 8_000) {
        throw new Error("Corrected memory text is invalid")
      }
      const owner = await ownerKey(ownerId)
      const [encryptedText, encryptedValue] = await Promise.all([
        protection.encryptText(owner.key, trimmed),
        candidate.sensitivity === "normal"
          ? Promise.resolve(undefined)
          : protection.encryptText(owner.key, JSON.stringify(trimmed))
      ])
      const replacementId = randomUuid()
      const createdAt = now().toISOString()
      if (!(await claimReview(candidate, "rejected", createdAt))) {
        const settled = await completedEffect(database, effect)
        if (settled !== undefined) return settled
        throw new Error("Memory candidate was already reviewed")
      }
      try {
        await database.batch([
          database.insert(memoryCandidates).values({
            id: replacementId,
            userId: ownerId,
            scope: candidate.scope,
            key: candidate.key,
            proposedValueJson: encryptedValue === undefined ? JSON.stringify(trimmed) : "null",
            proposedValueCiphertext: encryptedValue?.ciphertext,
            proposedValueIv: encryptedValue?.iv,
            canonicalTextCiphertext: encryptedText.ciphertext,
            canonicalTextIv: encryptedText.iv,
            memoryClass: "owner_fact",
            originClass: "owner_input",
            sourceType: candidate.sourceType,
            sourceId: candidate.sourceId,
            sourceLabel: candidate.sourceLabel,
            sourceOccurredAt: candidate.sourceOccurredAt,
            sourceContentHash: candidate.sourceContentHash,
            extractionConfidence: 1_000,
            sensitivity: candidate.sensitivity,
            status: "proposed",
            createdAt
          }),
          completeEffect(database, effect, replacementId, randomUuid(), createdAt)
        ])
      } catch (error) {
        try {
          return await completedEffectAfterConflict(database, effect, error)
        } catch (settlementError) {
          await releaseReview(candidate, "rejected", createdAt)
          throw settlementError
        }
      }
      return replacementId
    },

    async reject(ownerId, candidateId, idempotencyKey) {
      const effect: EffectIdentity = { ownerId, kind: "memory_reject", idempotencyKey }
      if ((await completedEffect(database, effect)) !== undefined) return
      const [candidate] = await database
        .select()
        .from(memoryCandidates)
        .where(and(eq(memoryCandidates.id, candidateId), eq(memoryCandidates.userId, ownerId)))
        .limit(1)
      if (candidate === undefined) throw new Error("Memory candidate not found")
      if (candidate.status !== "proposed" && candidate.status !== "disputed") {
        throw new Error("Memory candidate was already reviewed")
      }
      const reviewedAt = now().toISOString()
      if (!(await claimReview(candidate, "rejected", reviewedAt))) {
        if ((await completedEffect(database, effect)) !== undefined) return
        throw new Error("Memory candidate was already reviewed")
      }
      try {
        await database.batch([
          completeEffect(database, effect, candidateId, randomUuid(), reviewedAt)
        ])
      } catch (error) {
        try {
          await completedEffectAfterConflict(database, effect, error)
        } catch (settlementError) {
          await releaseReview(candidate, "rejected", reviewedAt)
          throw settlementError
        }
      }
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
          const review = {
            id: candidate.id,
            memoryClass: "owner_fact" as const,
            scope: candidate.scope,
            key: candidate.key,
            value: Schema.decodeUnknownSync(Schema.Json)(JSON.parse(serializedValue)),
            canonicalText,
            originClass: Schema.decodeUnknownSync(OriginClassValue)(candidate.originClass),
            sourceType: candidate.sourceType,
            sourceId: candidate.sourceId,
            sourceLabel: candidate.sourceLabel ?? legacyCandidateSourceLabel(candidate.createdAt),
            sensitivity: Schema.decodeUnknownSync(MemorySensitivity)(candidate.sensitivity),
            status: Schema.decodeUnknownSync(CandidateStatus)(candidate.status),
            createdAt: candidate.createdAt
          }
          return review
        })
      )
    },

    async search(ownerId, query, channel) {
      const ftsQuery = buildFtsQuery(query)
      if (ftsQuery === undefined) return []
      const rows = await database.all<{
        document_id: string
        source_id: string
        text: string
        source_type: string
        source_label: string
        memory_class: string
        occurred_at: string | null
        importance: number
      }>(sql`
        SELECT
          f.document_id,
          d.source_id,
          f.text,
          d.source_type,
          d.memory_class,
          f.source_label,
          d.occurred_at,
          d.importance
        FROM search_documents_fts AS f
        JOIN search_documents AS d ON d.id = f.document_id
        WHERE search_documents_fts MATCH ${ftsQuery}
          AND f.user_id = ${ownerId}
          AND d.deleted_at IS NULL
          AND d.model_eligible = 1
          AND (${channel ? 1 : 0} = 0 OR d.channel_eligible = 1)
        ORDER BY bm25(search_documents_fts), d.importance DESC
        LIMIT 36
      `)
      return rankRetrievalCandidates(
        rows.map((row, lexicalPosition) => {
          const candidate = {
            id: row.document_id,
            sourceId: row.source_id,
            sourceType: row.source_type,
            memoryClass: Schema.decodeUnknownSync(MemoryClassValue)(row.memory_class),
            text: row.text,
            sourceLabel: row.source_label,
            importance: row.importance,
            lexicalPosition
          }
          return row.occurred_at === null
            ? candidate
            : { ...candidate, occurredAt: row.occurred_at }
        })
      ).map(({ id, sourceId, text, sourceLabel, memoryClass, occurredAt }) => {
        const result = { id, sourceId, text, sourceLabel, memoryClass }
        return occurredAt === undefined ? result : { ...result, occurredAt }
      })
    }
  }
}

export function memoryStoreLayer(store: MemoryStore) {
  return Layer.succeed(MemoryStore, store)
}
