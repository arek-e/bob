import type { BatchItem } from "drizzle-orm/batch"

import {
  AgentRunOperation,
  AgentRunRequest,
  type AgentArtifact,
  type AgentRunResult
} from "@bob/contracts/agent"
import { and, asc, eq, isNull, lt, or, sql } from "drizzle-orm"
import { Context, Layer, Schema } from "effect"

import type { CoreDatabase } from "../../database.ts"
import type { DataProtection } from "../policy/data-protection.ts"
import type { OwnerDataKeyStore } from "../policy/owner-data-key.ts"

import { makeArtifactPersistence } from "../artifacts/persistence.ts"
import { outboxMessages } from "../delivery/schema.ts"
import { makeOwnerDataKeyStore } from "../policy/owner-data-key.ts"
import {
  agentRunAttempts,
  agentRunOperations,
  agentRuns,
  conversationTurns,
  inboundEvents,
  messages
} from "./schema.ts"

export interface StoredAgentRun {
  readonly request: AgentRunRequest
  readonly status:
    | "pending"
    | "claimed"
    | "executing"
    | "completed"
    | "failed"
    | "unknown"
    | "superseded"
  readonly outboxId?: string
}

export interface ConversationRunCompletion {
  readonly conversationTurnId: string
  readonly conversationTurnRevision: number
}

export interface ConversationReflectionCompletion extends ConversationRunCompletion {
  readonly settleUntil?: string
}

export type ConversationReflectionTransition =
  | { readonly status: "lost" }
  | {
      readonly status: "released" | "settling"
      readonly revision: number
      readonly wakeAt: string
    }

export type AgentRunRetryTransition =
  | { readonly status: "lost" | "exhausted" }
  | { readonly status: "released"; readonly wakeAt?: string }

export interface AgentRunStore {
  create(
    request: AgentRunRequest,
    inboundEventId: string
  ): Promise<{ runId: string; duplicate: boolean }>
  loadForInbound(inboundEventId: string): Promise<StoredAgentRun | undefined>
  loadForTurn(turnId: string, revision: number): Promise<StoredAgentRun | undefined>
  claim(runId: string, leaseMs: number): Promise<string | undefined>
  loadOperations(runId: string, attemptId: string): Promise<readonly AgentRunOperation[]>
  appendOperation(
    operation: AgentRunOperation,
    attemptId: string
  ): Promise<"appended" | "duplicate">
  releaseForRetry(
    result: AgentRunResult,
    attemptId: string,
    maxAttempts: number,
    retryDelayMs: number,
    conversation?: ConversationRunCompletion
  ): Promise<AgentRunRetryTransition>
  completeWithResponse(
    result: AgentRunResult,
    response: {
      readonly channelId: string
      readonly text: string
      readonly reasonCode: string
      readonly replyToMessageHandle?: string
      readonly artifact?: AgentArtifact
    },
    conversation?: ConversationRunCompletion,
    attemptId?: string
  ): Promise<string | undefined>
  completeWithoutResponse(result: AgentRunResult, attemptId: string): Promise<boolean>
  completeForReflection(
    result: AgentRunResult,
    attemptId: string,
    conversation: ConversationReflectionCompletion
  ): Promise<ConversationReflectionTransition>
  channelForRun(runId: string): Promise<string | undefined>
}

export const AgentRunStore = Context.Service<AgentRunStore>("bob/AgentRunStore")

const StoredRunEnvelope = Schema.Struct({
  ciphertext: Schema.String,
  iv: Schema.String,
  keyVersion: Schema.Number
})

export function makeAgentRunStore(
  database: CoreDatabase,
  protection: DataProtection,
  options: {
    readonly now?: () => Date
    readonly randomUuid?: () => string
    readonly ownerDataKeys?: OwnerDataKeyStore
  }
): AgentRunStore {
  const now = options.now ?? (() => new Date())
  const randomUuid = options.randomUuid ?? (() => crypto.randomUUID())
  const ownerDataKeys =
    options.ownerDataKeys ??
    makeOwnerDataKeyStore(database, protection, { defaultTimeZone: "UTC", now })
  const artifactPersistence = makeArtifactPersistence(database, protection, ownerDataKeys, {
    randomUuid
  })

  async function loadStoredRun(row: typeof agentRuns.$inferSelect): Promise<StoredAgentRun> {
    const envelope = Schema.decodeUnknownSync(StoredRunEnvelope)(JSON.parse(row.inputSnapshotJson))
    const owner = await ownerDataKeys.load(row.userId)
    const request = Schema.decodeUnknownSync(AgentRunRequest)(
      JSON.parse(
        await protection.decryptText(owner.key, {
          ciphertext: envelope.ciphertext,
          iv: envelope.iv
        })
      )
    )
    const [outbox] = await database
      .select({ id: outboxMessages.id })
      .from(outboxMessages)
      .where(eq(outboxMessages.idempotencyKey, `run:${row.id}:reply`))
      .limit(1)
    if (outbox === undefined) return { request, status: row.status }
    return { request, status: row.status, outboxId: outbox.id }
  }

  return {
    async create(request, inboundEventId) {
      const [existing] = await database
        .select({ id: agentRuns.id, inputHash: agentRuns.inputHash })
        .from(agentRuns)
        .where(
          request.conversationTurnId === undefined || request.conversationTurnRevision === undefined
            ? and(
                eq(agentRuns.inboundEventId, inboundEventId),
                isNull(agentRuns.conversationTurnId)
              )
            : and(
                eq(agentRuns.conversationTurnId, request.conversationTurnId),
                eq(agentRuns.conversationTurnRevision, request.conversationTurnRevision)
              )
        )
        .limit(1)
      const serialized = JSON.stringify(request)
      const hash = await protection.contentHash(serialized)
      if (existing !== undefined) {
        if (existing.inputHash !== hash) throw new Error("Agent run input snapshot changed")
        return { runId: existing.id, duplicate: true }
      }
      const owner = await ownerDataKeys.load(request.ownerId)
      const encrypted = await protection.encryptText(owner.key, serialized)
      const envelope = JSON.stringify({
        ciphertext: encrypted.ciphertext,
        iv: encrypted.iv,
        keyVersion: owner.version
      })
      await database.insert(agentRuns).values({
        id: request.runId,
        userId: request.ownerId,
        inboundEventId,
        conversationTurnId: request.conversationTurnId,
        conversationTurnRevision: request.conversationTurnRevision,
        targetMessageId: request.sourceMessageId,
        correlationId: request.correlationId,
        inputSnapshotJson: envelope,
        inputHash: hash,
        status: "pending",
        model: "configured-at-agent-host",
        createdAt: now().toISOString()
      })
      return { runId: request.runId, duplicate: false }
    },

    async loadForInbound(inboundEventId) {
      const [row] = await database
        .select()
        .from(agentRuns)
        .where(
          and(eq(agentRuns.inboundEventId, inboundEventId), isNull(agentRuns.conversationTurnId))
        )
        .limit(1)
      return row === undefined ? undefined : loadStoredRun(row)
    },

    async loadForTurn(turnId, revision) {
      const [row] = await database
        .select()
        .from(agentRuns)
        .where(
          and(
            eq(agentRuns.conversationTurnId, turnId),
            eq(agentRuns.conversationTurnRevision, revision)
          )
        )
        .limit(1)
      return row === undefined ? undefined : loadStoredRun(row)
    },

    async claim(runId, leaseMs) {
      const at = now()
      const attemptId = randomUuid()
      const atIso = at.toISOString()
      const claimable = and(
        eq(agentRuns.id, runId),
        or(
          eq(agentRuns.status, "pending"),
          // Pre-rollout claimed rows recover after their existing lease expires.
          and(eq(agentRuns.status, "claimed"), lt(agentRuns.claimExpiresAt, atIso)),
          and(eq(agentRuns.status, "executing"), lt(agentRuns.claimExpiresAt, atIso))
        )
      )
      const createAttempt = database
        .insert(agentRunAttempts)
        .select(
          database
            .select({
              id: sql<string>`${attemptId}`.as("id"),
              runId: agentRuns.id,
              attemptNumber:
                sql<number>`COALESCE((SELECT MAX(${agentRunAttempts.attemptNumber}) + 1 FROM ${agentRunAttempts} WHERE ${agentRunAttempts.runId} = ${runId}), 1)`.as(
                  "attempt_number"
                ),
              status: sql<string>`${"executing"}`.as("status"),
              errorCode: sql<string | null>`NULL`.as("error_code"),
              startedAt: sql<string>`${atIso}`.as("started_at"),
              finishedAt: sql<string | null>`NULL`.as("finished_at")
            })
            .from(agentRuns)
            .where(claimable)
        )
        .returning({ id: agentRunAttempts.id })
      const [created, claimed] = await database.batch([
        createAttempt,
        database
          .update(agentRuns)
          .set({
            status: "executing",
            claimedAt: atIso,
            claimExpiresAt: new Date(at.getTime() + leaseMs).toISOString(),
            activeAttemptId: attemptId
          })
          .where(
            and(
              claimable,
              sql`EXISTS (
                SELECT 1 FROM ${agentRunAttempts}
                WHERE ${agentRunAttempts.id} = ${attemptId}
                  AND ${agentRunAttempts.runId} = ${runId}
              )`
            )
          )
          .returning({ id: agentRuns.id })
      ])
      return created[0] !== undefined && claimed[0] !== undefined ? attemptId : undefined
    },

    async loadOperations(runId, attemptId) {
      const [run] = await database
        .select({ ownerId: agentRuns.userId })
        .from(agentRuns)
        .where(
          and(
            eq(agentRuns.id, runId),
            eq(agentRuns.status, "executing"),
            eq(agentRuns.activeAttemptId, attemptId)
          )
        )
        .limit(1)
      if (run === undefined) throw new Error("Agent run attempt is not active")
      const rows = await database
        .select()
        .from(agentRunOperations)
        .where(eq(agentRunOperations.runId, runId))
        .orderBy(asc(agentRunOperations.sequence))
      const owner = await ownerDataKeys.load(run.ownerId)
      return Promise.all(
        rows.map(async (row) =>
          Schema.decodeUnknownSync(AgentRunOperation)({
            protocolVersion: 1,
            loopVersion: row.loopVersion,
            runId: row.runId,
            sequence: row.sequence,
            kind: row.kind,
            payload: Schema.decodeUnknownSync(Schema.Json)(
              JSON.parse(
                await protection.decryptText(owner.key, {
                  ciphertext: row.payloadCiphertext,
                  iv: row.payloadIv
                })
              )
            )
          })
        )
      )
    },

    async appendOperation(operation, attemptId) {
      const decoded = Schema.decodeUnknownSync(AgentRunOperation)(operation)
      const serializedOperation = JSON.stringify(decoded)
      const payloadHash = await protection.contentHash(serializedOperation)
      const [run] = await database
        .select({ ownerId: agentRuns.userId })
        .from(agentRuns)
        .where(
          and(
            eq(agentRuns.id, decoded.runId),
            eq(agentRuns.status, "executing"),
            eq(agentRuns.activeAttemptId, attemptId)
          )
        )
        .limit(1)
      if (run === undefined) throw new Error("Agent run attempt is not active")
      const [existing] = await database
        .select({
          kind: agentRunOperations.kind,
          loopVersion: agentRunOperations.loopVersion,
          payloadHash: agentRunOperations.payloadHash
        })
        .from(agentRunOperations)
        .where(
          and(
            eq(agentRunOperations.runId, decoded.runId),
            eq(agentRunOperations.sequence, decoded.sequence)
          )
        )
        .limit(1)
      if (existing !== undefined) {
        if (
          existing.kind === decoded.kind &&
          existing.loopVersion === decoded.loopVersion &&
          existing.payloadHash === payloadHash
        ) {
          return "duplicate"
        }
        throw new Error("Agent run operation sequence conflict")
      }
      const owner = await ownerDataKeys.load(run.ownerId)
      const encrypted = await protection.encryptText(owner.key, JSON.stringify(decoded.payload))
      const id = randomUuid()
      const createdAt = now().toISOString()
      const [inserted] = await database
        .insert(agentRunOperations)
        .select(sql`
          SELECT
            ${id},
            ${decoded.runId},
            ${decoded.sequence},
            ${decoded.kind},
            ${decoded.loopVersion},
            ${encrypted.ciphertext},
            ${encrypted.iv},
            ${payloadHash},
            ${owner.version},
            ${attemptId},
            ${createdAt}
          FROM ${agentRuns}
          WHERE
            ${agentRuns.id} = ${decoded.runId}
            AND ${agentRuns.status} = ${"executing"}
            AND ${agentRuns.activeAttemptId} = ${attemptId}
            AND ${decoded.sequence} = COALESCE(
              (
                SELECT MAX(${agentRunOperations.sequence}) + 1
                FROM ${agentRunOperations}
                WHERE ${agentRunOperations.runId} = ${decoded.runId}
              ),
              1
            )
        `)
        .returning({ id: agentRunOperations.id })
      if (inserted !== undefined) return "appended"

      const [settled] = await database
        .select({
          kind: agentRunOperations.kind,
          loopVersion: agentRunOperations.loopVersion,
          payloadHash: agentRunOperations.payloadHash
        })
        .from(agentRunOperations)
        .where(
          and(
            eq(agentRunOperations.runId, decoded.runId),
            eq(agentRunOperations.sequence, decoded.sequence)
          )
        )
        .limit(1)
      if (
        settled?.kind === decoded.kind &&
        settled.loopVersion === decoded.loopVersion &&
        settled.payloadHash === payloadHash
      ) {
        return "duplicate"
      }
      throw new Error("Agent run operation append was fenced")
    },

    async releaseForRetry(result, attemptId, maxAttempts, retryDelayMs, conversation) {
      const [active] = await database
        .select({
          attemptNumber: agentRunAttempts.attemptNumber,
          inboundEventId: agentRuns.inboundEventId
        })
        .from(agentRunAttempts)
        .innerJoin(agentRuns, eq(agentRunAttempts.runId, agentRuns.id))
        .where(
          and(
            eq(agentRunAttempts.id, attemptId),
            eq(agentRunAttempts.runId, result.runId),
            isNull(agentRunAttempts.finishedAt),
            eq(agentRuns.status, "executing"),
            eq(agentRuns.activeAttemptId, attemptId)
          )
        )
        .limit(1)
      if (active === undefined) return { status: "lost" }
      if (active.attemptNumber >= maxAttempts) return { status: "exhausted" }

      const currentTime = now()
      const at = currentTime.toISOString()
      const retryAt = new Date(currentTime.getTime() + retryDelayMs).toISOString()
      const conversationAuthority =
        conversation === undefined
          ? undefined
          : sql`EXISTS (
              SELECT 1
              FROM ${conversationTurns}
              WHERE ${conversationTurns.id} = ${conversation.conversationTurnId}
                AND ${conversationTurns.revision} = ${conversation.conversationTurnRevision}
                AND ${conversationTurns.status} = 'running'
                AND ${conversationTurns.activeRunId} = ${result.runId}
                AND ${conversationTurns.activeRunRevision} = ${conversation.conversationTurnRevision}
                AND ${conversationTurns.replyOutboxId} IS NULL
            )`
      const activeAttempt = and(
        eq(agentRuns.id, result.runId),
        eq(agentRuns.status, "executing"),
        eq(agentRuns.activeAttemptId, attemptId),
        ...(conversationAuthority === undefined ? [] : [conversationAuthority])
      )
      const releaseRun = database
        .update(agentRuns)
        .set({
          status: "pending",
          claimedAt: null,
          claimExpiresAt: null,
          activeAttemptId: null,
          model: result.model
        })
        .where(activeAttempt)
        .returning({ id: agentRuns.id })
      const finishAttempt = database
        .update(agentRunAttempts)
        .set({ status: "retryable", errorCode: result.errorCode, finishedAt: at })
        .where(
          and(
            eq(agentRunAttempts.id, attemptId),
            eq(agentRunAttempts.runId, result.runId),
            isNull(agentRunAttempts.finishedAt),
            sql`EXISTS (
              SELECT 1 FROM ${agentRuns}
              WHERE ${agentRuns.id} = ${result.runId}
                AND ${agentRuns.status} = 'pending'
                AND ${agentRuns.activeAttemptId} IS NULL
            )`
          )
        )

      if (conversation !== undefined) {
        const releaseTurn = database
          .update(conversationTurns)
          .set({
            status: "collecting",
            activeRunId: null,
            activeRunRevision: null,
            claimedRevision: null,
            claimedAt: null,
            claimExpiresAt: null,
            quietUntil: sql`max(${conversationTurns.quietUntil}, ${retryAt})`,
            updatedAt: at
          })
          .where(
            and(
              eq(conversationTurns.id, conversation.conversationTurnId),
              eq(conversationTurns.revision, conversation.conversationTurnRevision),
              eq(conversationTurns.status, "running"),
              eq(conversationTurns.activeRunId, result.runId),
              eq(conversationTurns.activeRunRevision, conversation.conversationTurnRevision),
              isNull(conversationTurns.replyOutboxId),
              sql`EXISTS (
                SELECT 1 FROM ${agentRuns}
                WHERE ${agentRuns.id} = ${result.runId}
                  AND ${agentRuns.status} = 'pending'
                  AND ${agentRuns.activeAttemptId} IS NULL
              )`
            )
          )
          .returning({ wakeAt: conversationTurns.quietUntil })
        const [releasedRun, releasedTurn] = await database.batch([
          releaseRun,
          releaseTurn,
          finishAttempt
        ])
        const wakeAt = releasedTurn[0]?.wakeAt
        return releasedRun[0] === undefined || wakeAt === undefined
          ? { status: "lost" }
          : { status: "released", wakeAt }
      }

      const releaseInbound = database
        .update(inboundEvents)
        .set({ claimedAt: null, claimExpiresAt: null })
        .where(
          and(
            eq(inboundEvents.id, active.inboundEventId),
            isNull(inboundEvents.processedAt),
            sql`EXISTS (
              SELECT 1 FROM ${agentRuns}
              WHERE ${agentRuns.id} = ${result.runId}
                AND ${agentRuns.status} = 'pending'
                AND ${agentRuns.activeAttemptId} IS NULL
            )`
          )
        )
        .returning({ id: inboundEvents.id })
      const [releasedRun, releasedInbound] = await database.batch([
        releaseRun,
        releaseInbound,
        finishAttempt
      ])
      return releasedRun[0] === undefined || releasedInbound[0] === undefined
        ? { status: "lost" }
        : { status: "released" }
    },

    async completeWithResponse(result, response, conversation, attemptId) {
      const at = now().toISOString()
      const idempotencyKey = `run:${result.runId}:reply`
      const [existingOutbox] = await database
        .select({ id: outboxMessages.id })
        .from(outboxMessages)
        .where(eq(outboxMessages.idempotencyKey, idempotencyKey))
        .limit(1)
      if (existingOutbox !== undefined) {
        return attemptId === undefined ? existingOutbox.id : undefined
      }
      const [loadedRun] = await database
        .select({
          ownerId: agentRuns.userId,
          inboundEventId: agentRuns.inboundEventId,
          status: agentRuns.status
        })
        .from(agentRuns)
        .where(eq(agentRuns.id, result.runId))
        .limit(1)
      if (loadedRun === undefined) throw new Error("Agent run not found")
      const status = result.status === "completed" ? "completed" : "failed"
      if (
        attemptId === undefined &&
        loadedRun.status !== "completed" &&
        loadedRun.status !== "failed"
      ) {
        return undefined
      }
      const owner = await ownerDataKeys.load(loadedRun.ownerId)
      const encrypted = await protection.encryptText(owner.key, response.text)
      const messageId = randomUuid()
      const outboxId = randomUuid()
      const activeAttempt =
        attemptId === undefined
          ? undefined
          : and(
              eq(agentRuns.id, result.runId),
              eq(agentRuns.status, "executing"),
              eq(agentRuns.activeAttemptId, attemptId)
            )
      const messageInsert =
        activeAttempt === undefined
          ? database.insert(messages).values({
              id: messageId,
              userId: loadedRun.ownerId,
              channelId: response.channelId,
              direction: "outbound",
              textCiphertext: encrypted.ciphertext,
              textIv: encrypted.iv,
              dataKeyVersion: owner.version,
              occurredAt: at,
              createdAt: at
            })
          : database.insert(messages).select(sql`
              SELECT
                ${messageId},
                ${agentRuns.userId},
                ${response.channelId},
                ${"outbound"},
                ${encrypted.ciphertext},
                ${encrypted.iv},
                ${owner.version},
                ${at},
                ${at}
              FROM ${agentRuns}
              WHERE ${activeAttempt}
            `)
      const outboxInsert =
        activeAttempt === undefined
          ? database.insert(outboxMessages).values({
              id: outboxId,
              userId: loadedRun.ownerId,
              channelId: response.channelId,
              messageId,
              reasonCode: response.reasonCode,
              correlationId: result.correlationId,
              idempotencyKey,
              replyToProviderMessageHandle: response.replyToMessageHandle,
              conversationTurnId: conversation?.conversationTurnId,
              conversationTurnRevision: conversation?.conversationTurnRevision,
              state: "pending",
              createdAt: at
            })
          : database.insert(outboxMessages).select(sql`
              SELECT
                ${outboxId},
                ${agentRuns.userId},
                ${response.channelId},
                ${messageId},
                ${response.reasonCode},
                ${result.correlationId},
                ${idempotencyKey},
                NULL,
                NULL,
                ${response.replyToMessageHandle ?? null},
              ${conversation?.conversationTurnId ?? null},
              ${conversation?.conversationTurnRevision ?? null},
              NULL,
              NULL,
              NULL,
              ${"pending"},
                NULL,
                NULL,
                NULL,
                NULL,
              NULL,
              0,
              0,
              NULL,
              ${at}
              FROM ${agentRuns}
              WHERE ${activeAttempt}
            `)
      const artifactStatements: BatchItem<"sqlite">[] = []
      if (response.artifact !== undefined) {
        const artifactInput = {
          ownerId: loadedRun.ownerId,
          channelId: response.channelId,
          artifact: response.artifact,
          sourceIds: result.sourceIds ?? [],
          runId: result.runId,
          correlationId: result.correlationId,
          dependsOnOutboxId: outboxId,
          createdAt: at
        }
        const plan = await artifactPersistence.prepareRunRevision(
          attemptId === undefined ? artifactInput : { ...artifactInput, attemptId }
        )
        artifactStatements.push(...plan.statements)
      }
      const statements: [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]] = [
        messageInsert,
        outboxInsert,
        ...artifactStatements
      ]
      const legacyStatements =
        conversation === undefined
          ? [
              database
                .update(inboundEvents)
                .set({ processedAt: at, claimExpiresAt: null })
                .where(eq(inboundEvents.id, loadedRun.inboundEventId))
            ]
          : []
      if (attemptId !== undefined) {
        await database.batch([
          ...statements,
          ...legacyStatements,
          database
            .update(agentRuns)
            .set({
              status,
              completedAt: at,
              claimExpiresAt: null,
              activeAttemptId: null,
              model: result.model
            })
            .where(activeAttempt!),
          database
            .update(agentRunAttempts)
            .set({ status, errorCode: result.errorCode, finishedAt: at })
            .where(
              and(
                eq(agentRunAttempts.id, attemptId),
                eq(agentRunAttempts.runId, result.runId),
                isNull(agentRunAttempts.finishedAt)
              )
            )
        ])
      } else {
        await database.batch([...statements, ...legacyStatements])
      }
      const [committedOutbox] = await database
        .select({ id: outboxMessages.id })
        .from(outboxMessages)
        .where(eq(outboxMessages.idempotencyKey, idempotencyKey))
        .limit(1)
      return committedOutbox?.id
    },

    async completeWithoutResponse(result, attemptId) {
      const at = now().toISOString()
      const [superseded] = await database
        .update(agentRuns)
        .set({
          status: "superseded",
          completedAt: at,
          claimExpiresAt: null,
          activeAttemptId: null,
          model: result.model
        })
        .where(
          and(
            eq(agentRuns.id, result.runId),
            eq(agentRuns.status, "executing"),
            eq(agentRuns.activeAttemptId, attemptId)
          )
        )
        .returning({ id: agentRuns.id })
      if (superseded === undefined) return false
      await database.batch([
        database
          .update(agentRunAttempts)
          .set({ status: "superseded", errorCode: result.errorCode, finishedAt: at })
          .where(
            and(
              eq(agentRunAttempts.id, attemptId),
              eq(agentRunAttempts.runId, result.runId),
              isNull(agentRunAttempts.finishedAt)
            )
          )
      ])
      return true
    },

    async completeForReflection(result, attemptId, conversation) {
      const currentTime = now()
      const at = currentTime.toISOString()
      const settleUntil = conversation.settleUntil
      const settling = settleUntil !== undefined && Date.parse(settleUntil) > currentTime.getTime()
      const wakeAt =
        settling && settleUntil !== undefined
          ? sql<string>`max(${conversationTurns.quietUntil}, ${settleUntil})`
          : sql<string>`max(${conversationTurns.quietUntil}, ${at})`
      const [, transitioned] = await database.batch([
        database
          .update(agentRuns)
          .set({
            status: "superseded",
            completedAt: at,
            claimExpiresAt: null,
            activeAttemptId: null,
            model: result.model
          })
          .where(
            and(
              eq(agentRuns.id, result.runId),
              eq(agentRuns.status, "executing"),
              eq(agentRuns.activeAttemptId, attemptId),
              eq(agentRuns.conversationTurnId, conversation.conversationTurnId),
              eq(agentRuns.conversationTurnRevision, conversation.conversationTurnRevision)
            )
          ),
        database
          .update(conversationTurns)
          .set({
            status: settling ? "settling" : "collecting",
            revision: sql`CASE
              WHEN ${conversationTurns.revision} = ${conversation.conversationTurnRevision}
              THEN ${conversationTurns.revision} + 1
              ELSE ${conversationTurns.revision}
            END`,
            activeRunId: settling ? result.runId : null,
            activeRunRevision: settling ? conversation.conversationTurnRevision : null,
            ...(settling
              ? { claimExpiresAt: wakeAt }
              : {
                  claimedRevision: null,
                  claimedAt: null,
                  claimExpiresAt: null,
                  quietUntil: wakeAt
                }),
            updatedAt: at
          })
          .where(
            and(
              eq(conversationTurns.id, conversation.conversationTurnId),
              eq(conversationTurns.activeRunId, result.runId),
              eq(conversationTurns.activeRunRevision, conversation.conversationTurnRevision),
              isNull(conversationTurns.replyOutboxId),
              sql`${conversationTurns.revision} >= ${conversation.conversationTurnRevision}`,
              or(eq(conversationTurns.status, "running"), eq(conversationTurns.status, "settling")),
              sql`EXISTS (
                SELECT 1
                FROM agent_runs AS reflected_run
                WHERE reflected_run.id = ${result.runId}
                  AND reflected_run.status = 'superseded'
                  AND reflected_run.completed_at = ${at}
                  AND reflected_run.turn_id = ${conversation.conversationTurnId}
                  AND reflected_run.turn_revision = ${conversation.conversationTurnRevision}
              )`,
              sql`EXISTS (
                SELECT 1
                FROM agent_run_attempts AS reflected_attempt
                WHERE reflected_attempt.id = ${attemptId}
                  AND reflected_attempt.run_id = ${result.runId}
                  AND reflected_attempt.status = 'executing'
                  AND reflected_attempt.finished_at IS NULL
              )`
            )
          )
          .returning({
            status: conversationTurns.status,
            revision: conversationTurns.revision,
            quietUntil: conversationTurns.quietUntil,
            claimExpiresAt: conversationTurns.claimExpiresAt
          }),
        database
          .update(agentRunAttempts)
          .set({ status: "superseded", errorCode: result.errorCode, finishedAt: at })
          .where(
            and(
              eq(agentRunAttempts.id, attemptId),
              eq(agentRunAttempts.runId, result.runId),
              eq(agentRunAttempts.status, "executing"),
              isNull(agentRunAttempts.finishedAt),
              sql`EXISTS (
                SELECT 1
                FROM agent_runs AS reflected_run
                WHERE reflected_run.id = ${result.runId}
                  AND reflected_run.status = 'superseded'
                  AND reflected_run.completed_at = ${at}
              )`
            )
          )
      ])
      const transition = transitioned[0]
      if (transition === undefined) return { status: "lost" }
      if (transition.status === "settling") {
        if (transition.claimExpiresAt === null) return { status: "lost" }
        return {
          status: "settling",
          revision: transition.revision,
          wakeAt: transition.claimExpiresAt
        }
      }
      return {
        status: "released",
        revision: transition.revision,
        wakeAt: transition.quietUntil
      }
    },

    async channelForRun(runId) {
      const [row] = await database
        .select({ channelId: inboundEvents.channelId })
        .from(agentRuns)
        .innerJoin(inboundEvents, eq(agentRuns.inboundEventId, inboundEvents.id))
        .where(eq(agentRuns.id, runId))
        .limit(1)
      return row?.channelId
    }
  }
}

export function agentRunStoreLayer(store: AgentRunStore) {
  return Layer.succeed(AgentRunStore, store)
}
