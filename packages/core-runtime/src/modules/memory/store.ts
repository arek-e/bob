import {
  factEvidence,
  factRelations,
  factRevisions,
  facts,
  memoryCandidates,
  memoryReviewClaimGuards
} from "@bob/db/schema/memory"
import { searchDocuments } from "@bob/db/schema/retrieval"
import { and, desc, eq, sql } from "drizzle-orm"
import { Context, Layer, Schema } from "effect"

import type { CoreBatchQuery, CoreDatabase } from "../../database.ts"
import type { DataProtection } from "../policy/data-protection.ts"
import type { OwnerDataKeyStore } from "../policy/owner-data-key.ts"
import type { EvidenceSourceRegistry } from "./evidence.ts"

import {
  completeEffect,
  completedEffect,
  completedEffectAfterConflict,
  type EffectIdentity
} from "../policy/effect-outcome.ts"
import { makeOwnerDataKeyStore } from "../policy/owner-data-key.ts"
import { retrievalProjection } from "../retrieval/projection.ts"
import {
  canPromoteOrigin,
  decideCandidate,
  deriveConfirmedMemoryPolicy,
  deriveMemoryPolicy,
  type OriginClass
} from "./rules.ts"
import {
  decodeStoredMemoryValue,
  encodeMemoryValue,
  encryptedMemoryValue,
  plainMemoryValue,
  readMemoryValue
} from "./value-envelope.ts"

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

export type MemoryStore = OwnerFactStore

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

type ReviewAction = "confirm" | "correct" | "reject"

interface ReviewClaim {
  readonly action: ReviewAction
  readonly id: string
  readonly resultId: string
}

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
  options: {
    readonly now?: () => Date
    readonly randomUuid?: () => string
    readonly reviewClaimLeaseMs?: number
    readonly ownerDataKeys?: OwnerDataKeyStore
  }
): MemoryStore {
  const now = options.now ?? (() => new Date())
  const randomUuid = options.randomUuid ?? (() => crypto.randomUUID())
  const reviewClaimLeaseMs = options.reviewClaimLeaseMs ?? 60_000
  const ownerDataKeys =
    options.ownerDataKeys ??
    makeOwnerDataKeyStore(database, protection, { defaultTimeZone: "UTC", now })

  async function claimReview(
    candidate: typeof memoryCandidates.$inferSelect,
    action: ReviewAction,
    claimedAt: string
  ): Promise<ReviewClaim | undefined> {
    const claim: ReviewClaim = {
      action,
      id: randomUuid(),
      resultId: action === "reject" ? candidate.id : randomUuid()
    }
    const expiresAt = new Date(Date.parse(claimedAt) + reviewClaimLeaseMs).toISOString()
    const [claimed] = await database
      .update(memoryCandidates)
      .set({
        status: "claimed",
        reviewClaimAction: claim.action,
        reviewClaimId: claim.id,
        reviewClaimExpiresAt: expiresAt,
        reviewResultId: claim.resultId
      })
      .where(
        and(
          eq(memoryCandidates.id, candidate.id),
          eq(memoryCandidates.userId, candidate.userId),
          sql`${memoryCandidates.status} IN ('proposed', 'disputed')`
        )
      )
      .returning({
        action: memoryCandidates.reviewClaimAction,
        id: memoryCandidates.reviewClaimId,
        resultId: memoryCandidates.reviewResultId
      })
    if (claimed !== undefined) return claim

    const [existing] = await database
      .select({
        status: memoryCandidates.status,
        action: memoryCandidates.reviewClaimAction,
        id: memoryCandidates.reviewClaimId,
        expiresAt: memoryCandidates.reviewClaimExpiresAt,
        resultId: memoryCandidates.reviewResultId
      })
      .from(memoryCandidates)
      .where(
        and(eq(memoryCandidates.id, candidate.id), eq(memoryCandidates.userId, candidate.userId))
      )
      .limit(1)
    if (
      existing?.status !== "claimed" ||
      existing.action !== action ||
      existing.id === null ||
      existing.expiresAt === null ||
      existing.resultId === null ||
      existing.expiresAt > claimedAt
    ) {
      return undefined
    }
    const [renewed] = await database
      .update(memoryCandidates)
      .set({
        reviewClaimAction: claim.action,
        reviewClaimId: claim.id,
        reviewClaimExpiresAt: expiresAt,
        reviewResultId: claim.resultId
      })
      .where(
        and(
          eq(memoryCandidates.id, candidate.id),
          eq(memoryCandidates.userId, candidate.userId),
          eq(memoryCandidates.status, "claimed"),
          eq(memoryCandidates.reviewClaimAction, action),
          eq(memoryCandidates.reviewClaimId, existing.id),
          sql`${memoryCandidates.reviewClaimExpiresAt} <= ${claimedAt}`
        )
      )
      .returning({ id: memoryCandidates.id })
    if (renewed === undefined) return undefined
    return claim
  }

  function guardReview(
    candidate: typeof memoryCandidates.$inferSelect,
    claim: ReviewClaim
  ): CoreBatchQuery {
    return database.insert(memoryReviewClaimGuards).values({
      claimId: sql`(
        SELECT ${memoryCandidates.reviewClaimId}
        FROM ${memoryCandidates}
        WHERE ${memoryCandidates.id} = ${candidate.id}
          AND ${memoryCandidates.userId} = ${candidate.userId}
          AND ${memoryCandidates.status} = 'claimed'
          AND ${memoryCandidates.reviewClaimAction} = ${claim.action}
          AND ${memoryCandidates.reviewClaimId} = ${claim.id}
        LIMIT 1
      )`
    })
  }

  function releaseReviewGuard(claim: ReviewClaim): CoreBatchQuery {
    return database
      .delete(memoryReviewClaimGuards)
      .where(eq(memoryReviewClaimGuards.claimId, claim.id))
  }

  function settleReview(
    candidate: typeof memoryCandidates.$inferSelect,
    claim: ReviewClaim,
    status: "confirmed" | "rejected",
    reviewedAt: string
  ): CoreBatchQuery {
    return database
      .update(memoryCandidates)
      .set({
        status,
        reviewedAt,
        reviewClaimAction: null,
        reviewClaimId: null,
        reviewClaimExpiresAt: null,
        reviewResultId: null
      })
      .where(
        and(
          eq(memoryCandidates.id, candidate.id),
          eq(memoryCandidates.userId, candidate.userId),
          eq(memoryCandidates.status, "claimed"),
          eq(memoryCandidates.reviewClaimAction, claim.action),
          eq(memoryCandidates.reviewClaimId, claim.id)
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
      const owner = await ownerDataKeys.load(input.ownerId)
      const value = Schema.decodeUnknownSync(Schema.Json)(input.value)
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
            valueEnvelope: factRevisions.valueEnvelope,
            legacyValueJson: factRevisions.legacyValueJson,
            legacyValueCiphertext: factRevisions.legacyValueCiphertext,
            legacyValueIv: factRevisions.legacyValueIv,
            dataKeyVersion: factRevisions.dataKeyVersion
          })
          .from(factRevisions)
          .where(eq(factRevisions.id, current.revisionId))
          .limit(1)
        if (revision === undefined) throw new Error("Current fact revision is unavailable")
        const currentValue = await readMemoryValue(
          decodeStoredMemoryValue({
            envelope: revision.valueEnvelope,
            legacy: {
              valueJson: revision.legacyValueJson,
              valueCiphertext: revision.legacyValueCiphertext,
              valueIv: revision.legacyValueIv,
              keyVersion: revision.dataKeyVersion
            }
          }),
          owner,
          protection
        )
        conflictsWithConfirmed = JSON.stringify(currentValue) !== JSON.stringify(value)
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
      const serializedValue = JSON.stringify(value)
      const encryptedValue =
        policy.sensitivity === "normal"
          ? undefined
          : await protection.encryptText(owner.key, serializedValue)
      const valueEnvelope =
        encryptedValue === undefined
          ? plainMemoryValue(value)
          : encryptedMemoryValue(encryptedValue, owner.version)
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
            proposedValueEnvelope: encodeMemoryValue(valueEnvelope),
            legacyProposedValueJson: encryptedValue === undefined ? serializedValue : "null",
            legacyProposedValueCiphertext: encryptedValue?.ciphertext,
            legacyProposedValueIv: encryptedValue?.iv,
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
      if (
        candidate.status !== "proposed" &&
        candidate.status !== "disputed" &&
        candidate.status !== "claimed"
      ) {
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
      const createdAt = now().toISOString()
      const claim = await claimReview(candidate, "confirm", createdAt)
      if (claim === undefined) {
        const settled = await completedEffect(database, effect)
        if (settled !== undefined) return settled
        throw new Error("Memory candidate is already under review")
      }
      const revisionId = claim.resultId
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
      const owner = await ownerDataKeys.load(candidate.userId)
      const canonicalText = await protection.decryptText(owner.key, {
        ciphertext: candidate.canonicalTextCiphertext,
        iv: candidate.canonicalTextIv
      })
      const excerptHash = sourceEvidence.contentHash
      const canonicalContentHash = await protection.contentHash(canonicalText)
      const valueEnvelope = decodeStoredMemoryValue({
        envelope: candidate.proposedValueEnvelope,
        legacy: {
          valueJson: candidate.legacyProposedValueJson,
          valueCiphertext: candidate.legacyProposedValueCiphertext,
          valueIv: candidate.legacyProposedValueIv,
          keyVersion: owner.version
        }
      })
      const confirmedPolicy = deriveConfirmedMemoryPolicy({
        sensitivity: candidate.sensitivity === "high" ? "high" : sourceEvidence.sensitivity,
        disclosure: sourceEvidence.disclosure
      })
      const previousRevisionId = fact.currentRevisionId
      const statements: [CoreBatchQuery, ...CoreBatchQuery[]] = [
        guardReview(candidate, claim),
        database.insert(factRevisions).values({
          id: revisionId,
          factId: fact.id,
          valueEnvelope: encodeMemoryValue(valueEnvelope),
          legacyValueJson: candidate.legacyProposedValueJson,
          legacyValueCiphertext: candidate.legacyProposedValueCiphertext,
          legacyValueIv: candidate.legacyProposedValueIv,
          canonicalTextCiphertext: candidate.canonicalTextCiphertext,
          canonicalTextIv: candidate.canonicalTextIv,
          dataKeyVersion: owner.version,
          assertionKind:
            candidate.originClass === "system_record" ? "system_recorded" : "user_stated",
          originClass,
          observedAt: sourceEvidence.occurredAt ?? candidate.createdAt,
          validFrom: createdAt,
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
          database.insert(searchDocuments).values(
            retrievalProjection({
              id: randomUuid(),
              ownerId: candidate.userId,
              sourceType: "fact_revision",
              sourceId: revisionId,
              memoryClass: "owner_fact",
              text: canonicalText,
              searchText: `${candidate.scope} ${candidate.key} ${canonicalText}`,
              contentHash: canonicalContentHash,
              sourceLabel: candidate.sourceLabel ?? sourceEvidence.sourceLabel,
              occurredAt: sourceEvidence.occurredAt ?? candidate.createdAt,
              conflictKey: fact.id,
              validFrom: createdAt,
              importance: 500,
              sensitivity: confirmedPolicy.sensitivity,
              modelEligible: confirmedPolicy.modelEligible,
              channelEligible: confirmedPolicy.channelEligible,
              createdAt
            })
          )
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
            .set({ validTo: createdAt, updatedAt: createdAt })
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
      statements.push(
        settleReview(candidate, claim, "confirmed", createdAt),
        completeEffect(database, effect, revisionId, randomUuid(), createdAt),
        releaseReviewGuard(claim)
      )
      try {
        await database.batch(statements)
      } catch (error) {
        return completedEffectAfterConflict(database, effect, error)
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
      if (
        candidate.status !== "proposed" &&
        candidate.status !== "disputed" &&
        candidate.status !== "claimed"
      ) {
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
      const createdAt = now().toISOString()
      const claim = await claimReview(candidate, "correct", createdAt)
      if (claim === undefined) {
        const settled = await completedEffect(database, effect)
        if (settled !== undefined) return settled
        throw new Error("Memory candidate is already under review")
      }
      const replacementId = claim.resultId
      const owner = await ownerDataKeys.load(ownerId)
      const [encryptedText, encryptedValue] = await Promise.all([
        protection.encryptText(owner.key, trimmed),
        candidate.sensitivity === "normal"
          ? Promise.resolve(undefined)
          : protection.encryptText(owner.key, JSON.stringify(trimmed))
      ])
      const correctedValueEnvelope =
        encryptedValue === undefined
          ? plainMemoryValue(trimmed)
          : encryptedMemoryValue(encryptedValue, owner.version)
      try {
        await database.batch([
          guardReview(candidate, claim),
          database.insert(memoryCandidates).values({
            id: replacementId,
            userId: ownerId,
            scope: candidate.scope,
            key: candidate.key,
            proposedValueEnvelope: encodeMemoryValue(correctedValueEnvelope),
            legacyProposedValueJson:
              encryptedValue === undefined ? JSON.stringify(trimmed) : "null",
            legacyProposedValueCiphertext: encryptedValue?.ciphertext,
            legacyProposedValueIv: encryptedValue?.iv,
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
          settleReview(candidate, claim, "rejected", createdAt),
          completeEffect(database, effect, replacementId, randomUuid(), createdAt),
          releaseReviewGuard(claim)
        ])
      } catch (error) {
        return completedEffectAfterConflict(database, effect, error)
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
      if (
        candidate.status !== "proposed" &&
        candidate.status !== "disputed" &&
        candidate.status !== "claimed"
      ) {
        throw new Error("Memory candidate was already reviewed")
      }
      const reviewedAt = now().toISOString()
      const claim = await claimReview(candidate, "reject", reviewedAt)
      if (claim === undefined) {
        if ((await completedEffect(database, effect)) !== undefined) return
        throw new Error("Memory candidate is already under review")
      }
      try {
        await database.batch([
          guardReview(candidate, claim),
          settleReview(candidate, claim, "rejected", reviewedAt),
          completeEffect(database, effect, candidateId, randomUuid(), reviewedAt),
          releaseReviewGuard(claim)
        ])
      } catch (error) {
        await completedEffectAfterConflict(database, effect, error)
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
      const owner = await ownerDataKeys.load(ownerId)
      return Promise.all(
        rows.map(async (candidate) => {
          const canonicalText = await protection.decryptText(owner.key, {
            ciphertext: candidate.canonicalTextCiphertext,
            iv: candidate.canonicalTextIv
          })
          const value = await readMemoryValue(
            decodeStoredMemoryValue({
              envelope: candidate.proposedValueEnvelope,
              legacy: {
                valueJson: candidate.legacyProposedValueJson,
                valueCiphertext: candidate.legacyProposedValueCiphertext,
                valueIv: candidate.legacyProposedValueIv,
                keyVersion: owner.version
              }
            }),
            owner,
            protection
          )
          const review = {
            id: candidate.id,
            memoryClass: "owner_fact" as const,
            scope: candidate.scope,
            key: candidate.key,
            value,
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
    }
  }
}

export function memoryStoreLayer(store: MemoryStore) {
  return Layer.succeed(MemoryStore, store)
}
