import type { BatchItem } from "drizzle-orm/batch"

import { and, desc, eq, isNull, sql } from "drizzle-orm"
import { Context, Layer } from "effect"

import type { CoreDatabase } from "../../database.ts"
import type { DataProtection } from "../policy/data-protection.ts"

import { messages, users } from "../conversations/schema.ts"
import { journalEntries } from "../journal/schema.ts"
import {
  completeEffect,
  completedEffect,
  completedEffectAfterConflict,
  type EffectIdentity
} from "../policy/effect-outcome.ts"
import { reminders } from "../reminders/schema.ts"
import { routines, workoutSessions } from "../training/schema.ts"
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
  readonly sourceId: string
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
  readonly sourceLabel: string
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
  correct(
    ownerId: string,
    candidateId: string,
    canonicalText: string,
    idempotencyKey: string
  ): Promise<string>
  reject(ownerId: string, candidateId: string, idempotencyKey: string): Promise<void>
  listCandidates(ownerId: string): Promise<readonly MemoryCandidateReview[]>
  search(ownerId: string, query: string, channel: boolean): Promise<readonly MemorySearchResult[]>
}

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

function candidateSourceLabel(sourceType: string, createdAt: string): string {
  const [year = "", month = "", day = ""] = createdAt.slice(0, 10).split("-")
  const monthLabel = monthLabels[Number(month) - 1] ?? month
  const date = `${Number(day)} ${monthLabel} ${year}`
  switch (sourceType) {
    case "message":
      return `Owner message linked on ${date}`
    case "journal":
    case "journal_entry":
    case "journal_summary":
      return `Journal entry linked on ${date}`
    case "reminder":
      return `Saved reminder linked on ${date}`
    case "routine":
      return `Saved routine linked on ${date}`
    case "workout_session":
      return `Workout record linked on ${date}`
    default:
      return `Saved source linked on ${date}`
  }
}

async function candidateSourceDate(
  database: CoreDatabase,
  candidate: Pick<MemoryCandidateReview, "sourceType" | "sourceId" | "createdAt">
): Promise<string> {
  const source = (() => {
    switch (candidate.sourceType) {
      case "message":
        return database
          .select({ createdAt: messages.createdAt })
          .from(messages)
          .where(eq(messages.id, candidate.sourceId))
          .limit(1)
      case "journal":
      case "journal_entry":
      case "journal_summary":
        return database
          .select({ createdAt: journalEntries.createdAt })
          .from(journalEntries)
          .where(eq(journalEntries.id, candidate.sourceId))
          .limit(1)
      case "reminder":
        return database
          .select({ createdAt: reminders.createdAt })
          .from(reminders)
          .where(eq(reminders.id, candidate.sourceId))
          .limit(1)
      case "routine":
        return database
          .select({ createdAt: routines.createdAt })
          .from(routines)
          .where(eq(routines.id, candidate.sourceId))
          .limit(1)
      case "workout_session":
        return database
          .select({ createdAt: workoutSessions.createdAt })
          .from(workoutSessions)
          .where(eq(workoutSessions.id, candidate.sourceId))
          .limit(1)
      default:
        return undefined
    }
  })()
  if (source === undefined) return candidate.createdAt
  return (await source)[0]?.createdAt ?? candidate.createdAt
}

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
            originClass: input.originClass,
            sourceType: input.sourceType,
            sourceId: input.sourceId,
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
      const sourceCreatedAt = await candidateSourceDate(database, candidate)
      const excerptHash = await protection.contentHash(canonicalText)
      const sensitiveValue =
        candidate.proposedValueCiphertext === null || candidate.proposedValueIv === null
          ? undefined
          : {
              ciphertext: candidate.proposedValueCiphertext,
              iv: candidate.proposedValueIv
            }
      const confirmedPolicy = deriveConfirmedMemoryPolicy({
        authority,
        originClass: candidate.originClass as OriginClass,
        sourceType: candidate.sourceType,
        sensitivity: candidate.sensitivity as "normal" | "private" | "high"
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
          originClass: candidate.originClass as OriginClass,
          observedAt: candidate.createdAt,
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
            text: canonicalText,
            sourceLabel: candidateSourceLabel(candidate.sourceType, sourceCreatedAt),
            occurredAt: sourceCreatedAt,
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
      await validateEvidence(candidate)
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
            originClass: "owner_input",
            sourceType: candidate.sourceType,
            sourceId: candidate.sourceId,
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
          const sourceCreatedAt = await candidateSourceDate(database, candidate)
          return {
            id: candidate.id,
            scope: candidate.scope,
            key: candidate.key,
            value: JSON.parse(serializedValue) as unknown,
            canonicalText,
            originClass: candidate.originClass as OriginClass,
            sourceType: candidate.sourceType,
            sourceId: candidate.sourceId,
            sourceLabel: candidateSourceLabel(candidate.sourceType, sourceCreatedAt),
            sensitivity: candidate.sensitivity as "normal" | "private" | "high",
            status: candidate.status as "proposed" | "disputed",
            createdAt: candidate.createdAt
          }
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
        occurred_at: string | null
        importance: number
      }>(sql`
        SELECT
          f.document_id,
          d.source_id,
          f.text,
          d.source_type,
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
        rows.map((row, lexicalPosition) => ({
          id: row.document_id,
          sourceId: row.source_id,
          sourceType: row.source_type,
          text: row.text,
          sourceLabel: row.source_label,
          ...(row.occurred_at === null ? {} : { occurredAt: row.occurred_at }),
          importance: row.importance,
          lexicalPosition
        }))
      ).map(({ id, sourceId, text, sourceLabel, occurredAt }) => ({
        id,
        sourceId,
        text,
        sourceLabel,
        ...(occurredAt === undefined ? {} : { occurredAt })
      }))
    }
  }
}

export function memoryStoreLayer(store: MemoryStore) {
  return Layer.succeed(MemoryStore, store)
}
