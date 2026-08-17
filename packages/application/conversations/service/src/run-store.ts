import type { AgentRunStoreAdapter, StoredAgentRun } from "@bob/conversations-types/run-store"
import type { CoreDatabase, DatabaseQuery } from "@bob/db-types"
import type { DataProtection } from "@bob/policy-types/data-protection"
import type { OwnerDataKeyStoreAdapter } from "@bob/policy-types/owner-data-key"

import { AgentRunOperation, AgentRunRequest, AgentRunResult } from "@bob/agent-types/run"
import { makeArtifactPersistence } from "@bob/artifacts-service/persistence"
import { AgentRunStore, AgentRunStoreError } from "@bob/conversations-types/run-store"
import {
  agentRunAttempts,
  agentRunOperations,
  agentRunOutbox,
  agentRuns,
  conversationTurns,
  inboundEvents,
  messages
} from "@bob/db-service/schema/conversations"
import { outboxMessages } from "@bob/db-service/schema/delivery"
import { allInTransaction } from "@bob/db-types"
import { makeOwnerDataKeyStore } from "@bob/policy-service/owner-data-key"
import { liftPromiseOperation } from "@bob/shared-types/effect-adapter"
import { and, asc, eq, isNull, lt, or, sql } from "drizzle-orm"
import { Effect, Layer, Schema } from "effect"

export { AgentRunStore }
export type {
  AgentRunRetryTransition,
  AgentRunStoreAdapter,
  ConversationReflectionCompletion,
  ConversationReflectionTransition,
  ConversationRunCompletion,
  StoredAgentRun
} from "@bob/conversations-types/run-store"

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
    readonly ownerDataKeys?: OwnerDataKeyStoreAdapter
  }
): AgentRunStoreAdapter {
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
    const [outbox] = await Effect.runPromise(
      database
        .select({ id: outboxMessages.id })
        .from(outboxMessages)
        .where(eq(outboxMessages.idempotencyKey, `run:${row.id}:reply`))
        .limit(1)
    )
    let result: typeof AgentRunResult.Type | undefined
    if (row.outcomeSnapshotJson !== null) {
      const outcomeEnvelope = Schema.decodeUnknownSync(StoredRunEnvelope)(
        JSON.parse(row.outcomeSnapshotJson)
      )
      result = Schema.decodeUnknownSync(AgentRunResult)(
        JSON.parse(
          await protection.decryptText(owner.key, {
            ciphertext: outcomeEnvelope.ciphertext,
            iv: outcomeEnvelope.iv
          })
        )
      )
    }
    const stored = { request, status: row.status }
    const withAttempt =
      row.activeAttemptId === null ? stored : { ...stored, activeAttemptId: row.activeAttemptId }
    const withResult = result === undefined ? withAttempt : { ...withAttempt, result }
    return outbox === undefined ? withResult : { ...withResult, outboxId: outbox.id }
  }

  return {
    async create(request, inboundEventId) {
      const [existing] = await Effect.runPromise(
        database
          .select({ id: agentRuns.id, inputHash: agentRuns.inputHash })
          .from(agentRuns)
          .where(
            request.conversationTurnId === undefined ||
              request.conversationTurnRevision === undefined
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
      )
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
      await Effect.runPromise(
        database.insert(agentRuns).values({
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
      )
      return { runId: request.runId, duplicate: false }
    },

    async loadForInbound(inboundEventId) {
      const [row] = await Effect.runPromise(
        database
          .select()
          .from(agentRuns)
          .where(
            and(eq(agentRuns.inboundEventId, inboundEventId), isNull(agentRuns.conversationTurnId))
          )
          .limit(1)
      )
      return row === undefined ? undefined : loadStoredRun(row)
    },

    async loadForTurn(turnId, revision) {
      const [row] = await Effect.runPromise(
        database
          .select()
          .from(agentRuns)
          .where(
            and(
              eq(agentRuns.conversationTurnId, turnId),
              eq(agentRuns.conversationTurnRevision, revision)
            )
          )
          .limit(1)
      )
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
              fence:
                sql<number>`COALESCE((SELECT MAX(${agentRunAttempts.fence}) + 1 FROM ${agentRunAttempts} WHERE ${agentRunAttempts.runId} = ${runId}), 1)`.as(
                  "fence"
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
      const [created, claimed] = await Effect.runPromise(
        allInTransaction(database, [
          createAttempt,
          database
            .update(agentRuns)
            .set({
              status: "executing",
              claimedAt: atIso,
              claimExpiresAt: new Date(at.getTime() + leaseMs).toISOString(),
              activeAttemptId: attemptId,
              activeAttemptFence: sql`(
                SELECT ${agentRunAttempts.fence}
                FROM ${agentRunAttempts}
                WHERE ${agentRunAttempts.id} = ${attemptId}
              )`
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
      )
      return created[0] !== undefined && claimed[0] !== undefined ? attemptId : undefined
    },

    async loadOperations(runId, attemptId) {
      const [run] = await Effect.runPromise(
        database
          .select({ ownerId: agentRuns.userId })
          .from(agentRuns)
          .where(
            and(
              eq(agentRuns.id, runId),
              or(eq(agentRuns.status, "executing"), eq(agentRuns.status, "awaiting_finalization")),
              eq(agentRuns.activeAttemptId, attemptId)
            )
          )
          .limit(1)
      )
      if (run === undefined) throw new Error("Agent run attempt is not active")
      const rows = await Effect.runPromise(
        database
          .select()
          .from(agentRunOperations)
          .where(eq(agentRunOperations.runId, runId))
          .orderBy(asc(agentRunOperations.sequence))
      )
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
      const [run] = await Effect.runPromise(
        database
          .select({ ownerId: agentRuns.userId })
          .from(agentRuns)
          .where(
            and(
              eq(agentRuns.id, decoded.runId),
              or(eq(agentRuns.status, "executing"), eq(agentRuns.status, "awaiting_finalization")),
              eq(agentRuns.activeAttemptId, attemptId)
            )
          )
          .limit(1)
      )
      if (run === undefined) throw new Error("Agent run attempt is not active")
      const [existing] = await Effect.runPromise(
        database
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
      )
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
      const [inserted] = await Effect.runPromise(
        database
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
      )
      if (inserted !== undefined) return "appended"

      const [settled] = await Effect.runPromise(
        database
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
      )
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
      const [active] = await Effect.runPromise(
        database
          .select({
            attemptNumber: agentRunAttempts.attemptNumber,
            inboundEventId: agentRuns.inboundEventId,
            executionPoolId: agentRuns.executionPoolId,
            dispatchGeneration: agentRuns.dispatchGeneration
          })
          .from(agentRunAttempts)
          .innerJoin(agentRuns, eq(agentRunAttempts.runId, agentRuns.id))
          .where(
            and(
              eq(agentRunAttempts.id, attemptId),
              eq(agentRunAttempts.runId, result.runId),
              isNull(agentRunAttempts.finishedAt),
              or(eq(agentRuns.status, "executing"), eq(agentRuns.status, "awaiting_finalization")),
              eq(agentRuns.activeAttemptId, attemptId)
            )
          )
          .limit(1)
      )
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

      if (active.executionPoolId !== null) {
        const generation = active.dispatchGeneration + 1
        const outboxId = randomUuid()
        const releaseSharedRun = database
          .update(agentRuns)
          .set({
            status: "retry_wait",
            claimedAt: null,
            claimExpiresAt: null,
            activeAttemptId: null,
            dispatchGeneration: generation,
            outcomeSnapshotJson: null,
            outcomeHash: null,
            completedAt: null,
            model: result.model
          })
          .where(
            and(
              eq(agentRuns.id, result.runId),
              eq(agentRuns.status, "awaiting_finalization"),
              eq(agentRuns.activeAttemptId, attemptId),
              ...(conversationAuthority === undefined ? [] : [conversationAuthority])
            )
          )
          .returning({ id: agentRuns.id })
        const enqueueRetry = database
          .insert(agentRunOutbox)
          .select(
            database
              .select({
                id: sql<string>`${outboxId}`.as("id"),
                runId: agentRuns.id,
                kind: sql<"dispatch">`${"dispatch"}`.as("kind"),
                generation: agentRuns.dispatchGeneration,
                state: sql<"pending">`${"pending"}`.as("state"),
                availableAt: sql<string>`${retryAt}`.as("available_at"),
                claimedAt: sql<string | null>`NULL`.as("claimed_at"),
                claimToken: sql<string | null>`NULL`.as("claim_token"),
                claimExpiresAt: sql<string | null>`NULL`.as("claim_expires_at"),
                publishedAt: sql<string | null>`NULL`.as("published_at"),
                failureCount: sql<number>`0`.as("failure_count"),
                createdAt: sql<string>`${at}`.as("created_at")
              })
              .from(agentRuns)
              .where(
                and(
                  eq(agentRuns.id, result.runId),
                  eq(agentRuns.status, "retry_wait"),
                  eq(agentRuns.dispatchGeneration, generation),
                  isNull(agentRuns.activeAttemptId)
                )
              )
          )
          .onConflictDoNothing()
          .returning({ id: agentRunOutbox.id })
        const finishSharedAttempt = database
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
                  AND ${agentRuns.status} = 'retry_wait'
                  AND ${agentRuns.dispatchGeneration} = ${generation}
              )`
            )
          )
          .returning({ id: agentRunAttempts.id })
        const [released, enqueued, finished] = await Effect.runPromise(
          allInTransaction(database, [releaseSharedRun, enqueueRetry, finishSharedAttempt])
        )
        return released[0] === undefined || enqueued[0] === undefined || finished[0] === undefined
          ? { status: "lost" }
          : { status: "released", wakeAt: retryAt }
      }

      const activeAttempt = and(
        eq(agentRuns.id, result.runId),
        or(eq(agentRuns.status, "executing"), eq(agentRuns.status, "awaiting_finalization")),
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
            quietUntil: sql`greatest(${conversationTurns.quietUntil}, ${retryAt})`,
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
        const [releasedRun, releasedTurn] = await Effect.runPromise(
          allInTransaction(database, [releaseRun, releaseTurn, finishAttempt])
        )
        const wakeAt = releasedTurn[0]?.wakeAt
        return releasedRun[0] === undefined || wakeAt === undefined
          ? { status: "lost" }
          : { status: "released", wakeAt }
      }

      if (active.inboundEventId === null) return { status: "lost" }
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
      const [releasedRun, releasedInbound] = await Effect.runPromise(
        allInTransaction(database, [releaseRun, releaseInbound, finishAttempt])
      )
      return releasedRun[0] === undefined || releasedInbound[0] === undefined
        ? { status: "lost" }
        : { status: "released" }
    },

    async completeWithResponse(result, response, conversation, attemptId) {
      const at = now().toISOString()
      const idempotencyKey = `run:${result.runId}:reply`
      const [existingOutbox] = await Effect.runPromise(
        database
          .select({ id: outboxMessages.id })
          .from(outboxMessages)
          .where(eq(outboxMessages.idempotencyKey, idempotencyKey))
          .limit(1)
      )
      if (existingOutbox !== undefined) {
        return attemptId === undefined ? existingOutbox.id : undefined
      }
      const [loadedRun] = await Effect.runPromise(
        database
          .select({
            ownerId: agentRuns.userId,
            inboundEventId: agentRuns.inboundEventId,
            status: agentRuns.status
          })
          .from(agentRuns)
          .where(eq(agentRuns.id, result.runId))
          .limit(1)
      )
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
              or(eq(agentRuns.status, "executing"), eq(agentRuns.status, "awaiting_finalization")),
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
      const artifactStatements: DatabaseQuery[] = []
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
      const statements: [DatabaseQuery, ...DatabaseQuery[]] = [
        messageInsert,
        outboxInsert,
        ...artifactStatements
      ]
      const legacyStatements =
        conversation === undefined && loadedRun.inboundEventId !== null
          ? [
              database
                .update(inboundEvents)
                .set({ processedAt: at, claimExpiresAt: null })
                .where(eq(inboundEvents.id, loadedRun.inboundEventId))
            ]
          : []
      if (attemptId !== undefined) {
        await Effect.runPromise(
          allInTransaction(database, [
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
        )
      } else {
        await Effect.runPromise(allInTransaction(database, [...statements, ...legacyStatements]))
      }
      const [committedOutbox] = await Effect.runPromise(
        database
          .select({ id: outboxMessages.id })
          .from(outboxMessages)
          .where(eq(outboxMessages.idempotencyKey, idempotencyKey))
          .limit(1)
      )
      return committedOutbox?.id
    },

    async completeWithoutResponse(result, attemptId) {
      const at = now().toISOString()
      const [superseded] = await Effect.runPromise(
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
              or(eq(agentRuns.status, "executing"), eq(agentRuns.status, "awaiting_finalization")),
              eq(agentRuns.activeAttemptId, attemptId)
            )
          )
          .returning({ id: agentRuns.id })
      )
      if (superseded === undefined) return false
      await Effect.runPromise(
        allInTransaction(database, [
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
      )
      return true
    },

    async completeForReflection(result, attemptId, conversation) {
      const currentTime = now()
      const at = currentTime.toISOString()
      const settleUntil = conversation.settleUntil
      const settling = settleUntil !== undefined && Date.parse(settleUntil) > currentTime.getTime()
      const wakeAt =
        settling && settleUntil !== undefined
          ? sql<string>`greatest(${conversationTurns.quietUntil}, ${settleUntil})`
          : sql<string>`greatest(${conversationTurns.quietUntil}, ${at})`
      const [, transitioned] = await Effect.runPromise(
        allInTransaction(database, [
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
                or(
                  eq(agentRuns.status, "executing"),
                  eq(agentRuns.status, "awaiting_finalization")
                ),
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
                or(
                  eq(conversationTurns.status, "running"),
                  eq(conversationTurns.status, "settling")
                ),
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
                  AND reflected_attempt.status IN ('executing', 'executed')
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
                or(
                  eq(agentRunAttempts.status, "executing"),
                  eq(agentRunAttempts.status, "executed")
                ),
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
      )
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
      const [row] = await Effect.runPromise(
        database
          .select({ channelId: inboundEvents.channelId })
          .from(agentRuns)
          .innerJoin(inboundEvents, eq(agentRuns.inboundEventId, inboundEvents.id))
          .where(eq(agentRuns.id, runId))
          .limit(1)
      )
      return row?.channelId
    }
  }
}

export function agentRunStoreLayer(store: AgentRunStoreAdapter) {
  const failure = (operation: keyof AgentRunStoreAdapter) => (cause: unknown) =>
    new AgentRunStoreError({ operation: String(operation), cause })
  return Layer.succeed(
    AgentRunStore,
    AgentRunStore.of({
      create: liftPromiseOperation(store.create, failure("create")),
      loadForInbound: liftPromiseOperation(store.loadForInbound, failure("loadForInbound")),
      loadForTurn: liftPromiseOperation(store.loadForTurn, failure("loadForTurn")),
      claim: liftPromiseOperation(store.claim, failure("claim")),
      loadOperations: liftPromiseOperation(store.loadOperations, failure("loadOperations")),
      appendOperation: liftPromiseOperation(store.appendOperation, failure("appendOperation")),
      releaseForRetry: liftPromiseOperation(store.releaseForRetry, failure("releaseForRetry")),
      completeWithResponse: liftPromiseOperation(
        store.completeWithResponse,
        failure("completeWithResponse")
      ),
      completeWithoutResponse: liftPromiseOperation(
        store.completeWithoutResponse,
        failure("completeWithoutResponse")
      ),
      completeForReflection: liftPromiseOperation(
        store.completeForReflection,
        failure("completeForReflection")
      ),
      channelForRun: liftPromiseOperation(store.channelForRun, failure("channelForRun"))
    })
  )
}
