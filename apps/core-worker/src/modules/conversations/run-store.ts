import { AgentRunRequest, type AgentRunResult } from "@bob/contracts/agent"
import { and, eq, isNull, lt, or, sql } from "drizzle-orm"
import { Context, Layer, Schema } from "effect"

import type { CoreDatabase } from "../../database.ts"
import type { DataProtection } from "../policy/data-protection.ts"

import { outboxMessages } from "../delivery/schema.ts"
import { agentRunAttempts, agentRuns, inboundEvents, messages, users } from "./schema.ts"

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

export interface AgentRunStore {
  create(
    request: AgentRunRequest,
    inboundEventId: string
  ): Promise<{ runId: string; duplicate: boolean }>
  loadForInbound(inboundEventId: string): Promise<StoredAgentRun | undefined>
  claim(runId: string, leaseMs: number): Promise<string | undefined>
  completeWithResponse(
    result: AgentRunResult,
    response: {
      readonly channelId: string
      readonly text: string
      readonly reasonCode: string
      readonly replyToMessageHandle?: string
    },
    conversation?: ConversationRunCompletion,
    attemptId?: string
  ): Promise<string | undefined>
  completeWithoutResponse(result: AgentRunResult, attemptId: string): Promise<boolean>
  channelForRun(runId: string): Promise<string | undefined>
}

export const AgentRunStore = Context.Service<AgentRunStore>("bob/AgentRunStore")

export function makeAgentRunStore(
  database: CoreDatabase,
  protection: DataProtection,
  options: { readonly now?: () => Date; readonly randomUuid?: () => string }
): AgentRunStore {
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
    async create(request, inboundEventId) {
      const [existing] = await database
        .select({ id: agentRuns.id, inputHash: agentRuns.inputHash })
        .from(agentRuns)
        .where(eq(agentRuns.inboundEventId, inboundEventId))
        .limit(1)
      const serialized = JSON.stringify(request)
      const hash = await protection.contentHash(serialized)
      if (existing !== undefined) {
        if (existing.inputHash !== hash) throw new Error("Agent run input snapshot changed")
        return { runId: existing.id, duplicate: true }
      }
      const owner = await ownerKey(request.ownerId)
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
        .where(eq(agentRuns.inboundEventId, inboundEventId))
        .limit(1)
      if (row === undefined) return undefined
      const envelope = JSON.parse(row.inputSnapshotJson) as {
        ciphertext: string
        iv: string
        keyVersion: number
      }
      const owner = await ownerKey(row.userId)
      const request = Schema.decodeUnknownSync(AgentRunRequest)(
        JSON.parse(
          await protection.decryptText(owner.key, {
            ciphertext: envelope.ciphertext,
            iv: envelope.iv
          })
        ) as unknown
      )
      const [outbox] = await database
        .select({ id: outboxMessages.id })
        .from(outboxMessages)
        .where(eq(outboxMessages.idempotencyKey, `run:${row.id}:reply`))
        .limit(1)
      return {
        request,
        status: row.status,
        ...(outbox === undefined ? {} : { outboxId: outbox.id })
      }
    },

    async claim(runId, leaseMs) {
      const at = now()
      const attemptId = randomUuid()
      const [claimed] = await database
        .update(agentRuns)
        .set({
          status: "claimed",
          claimedAt: at.toISOString(),
          claimExpiresAt: new Date(at.getTime() + leaseMs).toISOString(),
          activeAttemptId: attemptId
        })
        .where(
          and(
            eq(agentRuns.id, runId),
            or(
              eq(agentRuns.status, "pending"),
              and(eq(agentRuns.status, "claimed"), lt(agentRuns.claimExpiresAt, at.toISOString())),
              and(eq(agentRuns.status, "executing"), lt(agentRuns.claimExpiresAt, at.toISOString()))
            )
          )
        )
        .returning({ id: agentRuns.id })
      if (claimed === undefined) return undefined
      const attempts = await database
        .select({ id: agentRunAttempts.id })
        .from(agentRunAttempts)
        .where(eq(agentRunAttempts.runId, runId))
      await database.batch([
        database
          .update(agentRuns)
          .set({ status: "executing" })
          .where(
            and(
              eq(agentRuns.id, runId),
              eq(agentRuns.status, "claimed"),
              eq(agentRuns.activeAttemptId, attemptId)
            )
          ),
        database.insert(agentRunAttempts).values({
          id: attemptId,
          runId,
          attemptNumber: attempts.length + 1,
          status: "executing",
          startedAt: at.toISOString()
        })
      ])
      return attemptId
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
      const owner = await ownerKey(loadedRun.ownerId)
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
                ${"pending"},
                NULL,
                NULL,
                NULL,
                NULL,
                ${at}
              FROM ${agentRuns}
              WHERE ${activeAttempt}
            `)
      const statements = [messageInsert, outboxInsert] as const
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
