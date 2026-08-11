import { AgentRunRequest, type AgentRunResult } from "@bob/contracts/agent"
import { and, eq, isNull, lt, or } from "drizzle-orm"
import { Context, Layer, Schema } from "effect"

import type { CoreDatabase } from "../../database.ts"
import type { DataProtection } from "../policy/data-protection.ts"
import { outboxMessages } from "../delivery/schema.ts"
import { agentRunAttempts, agentRuns, inboundEvents, messages, users } from "./schema.ts"

export interface StoredAgentRun {
  readonly request: AgentRunRequest
  readonly status: "pending" | "claimed" | "executing" | "completed" | "failed" | "unknown"
  readonly outboxId?: string
}

export interface AgentRunStore {
  create(
    request: AgentRunRequest,
    inboundEventId: string
  ): Promise<{ runId: string; duplicate: boolean }>
  loadForInbound(inboundEventId: string): Promise<StoredAgentRun | undefined>
  claim(runId: string, leaseMs: number): Promise<boolean>
  completeWithResponse(
    result: AgentRunResult,
    response: {
      readonly channelId: string
      readonly text: string
      readonly reasonCode: string
    }
  ): Promise<string>
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
      const [claimed] = await database
        .update(agentRuns)
        .set({
          status: "claimed",
          claimedAt: at.toISOString(),
          claimExpiresAt: new Date(at.getTime() + leaseMs).toISOString()
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
      if (claimed === undefined) return false
      const attempts = await database
        .select({ id: agentRunAttempts.id })
        .from(agentRunAttempts)
        .where(eq(agentRunAttempts.runId, runId))
      await database.batch([
        database
          .update(agentRuns)
          .set({ status: "executing" })
          .where(and(eq(agentRuns.id, runId), eq(agentRuns.status, "claimed"))),
        database.insert(agentRunAttempts).values({
          id: randomUuid(),
          runId,
          attemptNumber: attempts.length + 1,
          status: "executing",
          startedAt: at.toISOString()
        })
      ])
      return true
    },

    async completeWithResponse(result, response) {
      const at = now().toISOString()
      const idempotencyKey = `run:${result.runId}:reply`
      const [existingOutbox] = await database
        .select({ id: outboxMessages.id })
        .from(outboxMessages)
        .where(eq(outboxMessages.idempotencyKey, idempotencyKey))
        .limit(1)
      if (existingOutbox !== undefined) return existingOutbox.id
      const [run] = await database
        .select({ ownerId: agentRuns.userId, inboundEventId: agentRuns.inboundEventId })
        .from(agentRuns)
        .where(eq(agentRuns.id, result.runId))
        .limit(1)
      if (run === undefined) throw new Error("Agent run not found")
      const owner = await ownerKey(run.ownerId)
      const encrypted = await protection.encryptText(owner.key, response.text)
      const messageId = randomUuid()
      const outboxId = randomUuid()
      const [attempt] = await database
        .select({ id: agentRunAttempts.id })
        .from(agentRunAttempts)
        .where(and(eq(agentRunAttempts.runId, result.runId), isNull(agentRunAttempts.finishedAt)))
        .limit(1)
      const status = result.status === "completed" ? "completed" : "failed"
      const statements = [
        database
          .update(agentRuns)
          .set({ status, completedAt: at, claimExpiresAt: null, model: result.model })
          .where(eq(agentRuns.id, result.runId)),
        database.insert(messages).values({
          id: messageId,
          userId: run.ownerId,
          channelId: response.channelId,
          direction: "outbound",
          textCiphertext: encrypted.ciphertext,
          textIv: encrypted.iv,
          dataKeyVersion: owner.version,
          occurredAt: at,
          createdAt: at
        }),
        database.insert(outboxMessages).values({
          id: outboxId,
          userId: run.ownerId,
          channelId: response.channelId,
          messageId,
          reasonCode: response.reasonCode,
          correlationId: result.correlationId,
          idempotencyKey,
          state: "pending",
          createdAt: at
        }),
        database
          .update(inboundEvents)
          .set({ processedAt: at, claimExpiresAt: null })
          .where(eq(inboundEvents.id, run.inboundEventId))
      ] as const
      if (attempt !== undefined) {
        await database.batch([
          ...statements,
          database
            .update(agentRunAttempts)
            .set({ status, errorCode: result.errorCode, finishedAt: at })
            .where(eq(agentRunAttempts.id, attempt.id))
        ])
      } else {
        await database.batch(statements)
      }
      return outboxId
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
