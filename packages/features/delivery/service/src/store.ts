import type { CoreDatabase, DatabaseQuery } from "@bob/db-types"
import type { DeliveryStoreAdapter } from "@bob/delivery-types/store"
import type { DataProtection } from "@bob/policy-types/data-protection"
import type { OwnerDataKeyStoreAdapter } from "@bob/policy-types/owner-data-key"

import { liftPromiseAdapter } from "@bob/capabilities-types/effect-adapter"
import {
  ProviderDeliveryStatus,
  type NormalizedStatusEvent
} from "@bob/conversations-types/channel"
import { operationalAlerts } from "@bob/db-service/schema/alerts"
import { channels, conversationTurns, messages } from "@bob/db-service/schema/conversations"
import { deliveryAttempts, outboxMessages, providerEvents } from "@bob/db-service/schema/delivery"
import { allInTransaction } from "@bob/db-types"
import { DeliveryStore, DeliveryStoreError } from "@bob/delivery-types/store"
import { recordOperationalAlert } from "@bob/operations-service/alerts/store"
import { makeOwnerDataKeyStore } from "@bob/policy-service/owner-data-key"
import { and, desc, eq, inArray, isNull, lt, sql } from "drizzle-orm"
import { Effect, Layer, Schema } from "effect"

import {
  makeDeliveryTargetRegistry,
  type DeliveryTargetAdapter,
  type DeliveryTargetOutcome
} from "./target-adapter.ts"

export { DeliveryStore }
export type {
  CreateOutboxInput,
  DeliveryReconciliationTarget,
  DeliveryStoreAdapter
} from "@bob/delivery-types/store"

interface DeliveryReconciliationIdentity {
  readonly outboxId: string
  readonly attemptId: string
  readonly correlationId: string
}

const acceptedDependency = sql<boolean>`(
  ${outboxMessages.dependsOnOutboxId} IS NULL
  OR EXISTS (
    SELECT 1
    FROM outbox_messages AS predecessor
    WHERE predecessor.id = ${outboxMessages.dependsOnOutboxId}
      AND predecessor.state = 'accepted'
  )
)`

const currentConversationReply = sql<boolean>`(
  ${acceptedDependency}
  AND (
    (${outboxMessages.conversationTurnId} IS NULL AND ${outboxMessages.conversationTurnRevision} IS NULL)
  OR (
    ${outboxMessages.conversationTurnId} IS NOT NULL
    AND ${outboxMessages.conversationTurnRevision} IS NOT NULL
    AND EXISTS (
      SELECT 1
      FROM ${conversationTurns}
      WHERE ${conversationTurns.id} = ${outboxMessages.conversationTurnId}
        AND ${conversationTurns.revision} = ${outboxMessages.conversationTurnRevision}
        AND ${conversationTurns.replyOutboxId} = ${outboxMessages.id}
        AND ${conversationTurns.status} = 'committing'
    )
  )
  )
)`

const deferredDependency = sql<boolean>`(
  ${outboxMessages.dependsOnOutboxId} IS NOT NULL
  AND EXISTS (
    SELECT 1
    FROM outbox_messages AS predecessor
    WHERE predecessor.id = ${outboxMessages.dependsOnOutboxId}
      AND predecessor.state IN ('pending', 'claimed', 'uncertain')
  )
)`

const deferredConversationReply = sql<boolean>`(
  ${deferredDependency}
  OR (
    ${outboxMessages.conversationTurnId} IS NOT NULL
    AND ${outboxMessages.conversationTurnRevision} IS NOT NULL
    AND EXISTS (
      SELECT 1
      FROM ${conversationTurns}
      WHERE ${conversationTurns.id} = ${outboxMessages.conversationTurnId}
        AND ${conversationTurns.revision} = ${outboxMessages.conversationTurnRevision}
        AND ${conversationTurns.replyOutboxId} IS NULL
        AND ${conversationTurns.status} IN ('collecting', 'running', 'settling', 'committing')
    )
  )
)`

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("")
}

export const recoverablePendingOutbox = and(
  eq(outboxMessages.state, "pending"),
  isNull(outboxMessages.enqueuedAt),
  currentConversationReply
)

export function makeDeliveryStore(
  database: CoreDatabase,
  protection: DataProtection,
  options: {
    readonly channelProviderId: string
    readonly now?: () => Date
    readonly randomUuid?: () => string
    readonly targetAdapters?: readonly DeliveryTargetAdapter[]
    readonly ownerDataKeys?: OwnerDataKeyStoreAdapter
  }
): DeliveryStoreAdapter {
  const now = options.now ?? (() => new Date())
  const randomUuid = options.randomUuid ?? (() => crypto.randomUUID())
  const targets = makeDeliveryTargetRegistry(options.targetAdapters)
  const ownerDataKeys =
    options.ownerDataKeys ??
    makeOwnerDataKeyStore(database, protection, { defaultTimeZone: "UTC", now })
  async function targetStatements(input: {
    readonly outcome: DeliveryTargetOutcome
    readonly targetType: string | null
    readonly targetId: string | null
    readonly ownerId: string
    readonly messageId: string
    readonly occurredAt: string
  }): Promise<readonly DatabaseQuery[]> {
    if (input.targetType === null || input.targetId === null) return []
    const adapter = targets.adapterFor(input.targetType)
    if (adapter === undefined) return []
    return adapter.statements({
      outcome: input.outcome,
      targetId: input.targetId,
      ownerId: input.ownerId,
      messageId: input.messageId,
      occurredAt: input.occurredAt
    })
  }
  type ApplicableStatusEvent = Omit<NormalizedStatusEvent, "destinationE164" | "providerOptedOut">

  async function applyProviderEvent(event: ApplicableStatusEvent): Promise<void> {
    const [attempt] = await Effect.runPromise(
      database
        .select()
        .from(deliveryAttempts)
        .where(eq(deliveryAttempts.providerMessageHandle, event.messageHandle))
        .limit(1)
    )
    if (attempt === undefined) return
    const [outbox] = await Effect.runPromise(
      database.select().from(outboxMessages).where(eq(outboxMessages.id, attempt.outboxId)).limit(1)
    )
    if (outbox === undefined) return

    const next =
      event.status === "delivered"
        ? ("delivered" as const)
        : event.status === "error" || event.status === "declined" || event.status === "opted_out"
          ? ("failed" as const)
          : ("accepted" as const)
    const terminal = attempt.state === "delivered" || attempt.state === "failed"
    const resolvesUncertain =
      attempt.state === "uncertain" && (next === "delivered" || next === "failed")
    const canAdvance = !terminal && (attempt.state !== "uncertain" || resolvesUncertain)
    const statements: [DatabaseQuery, ...DatabaseQuery[]] = [
      database
        .update(deliveryAttempts)
        .set(
          canAdvance
            ? { state: next, updatedAt: event.occurredAt }
            : { updatedAt: event.occurredAt }
        )
        .where(and(eq(deliveryAttempts.id, attempt.id), eq(deliveryAttempts.state, attempt.state)))
    ]
    if (canAdvance && (next === "delivered" || next === "failed")) {
      statements.push(
        database
          .update(outboxMessages)
          .set({
            state: next === "delivered" ? "accepted" : "failed",
            completedAt: event.occurredAt,
            claimExpiresAt: null
          })
          .where(
            and(
              eq(outboxMessages.id, outbox.id),
              inArray(outboxMessages.state, ["claimed", "accepted", "uncertain"])
            )
          )
      )
      if (next === "failed") {
        statements.push(
          ...(await targetStatements({
            outcome: "failed",
            targetType: outbox.actionTargetType,
            targetId: outbox.actionTargetId,
            ownerId: outbox.userId,
            messageId: outbox.messageId,
            occurredAt: event.occurredAt
          }))
        )
      }
      if (next === "failed") {
        statements.push(
          database
            .update(outboxMessages)
            .set({ state: "cancelled", completedAt: event.occurredAt })
            .where(
              and(
                eq(outboxMessages.dependsOnOutboxId, outbox.id),
                eq(outboxMessages.state, "pending")
              )
            )
        )
      }
    }
    if (event.status === "opted_out") {
      statements.push(
        database
          .update(channels)
          .set({ optedOutAt: event.occurredAt, optedInAt: null })
          .where(eq(channels.id, outbox.channelId))
      )
    }
    await Effect.runPromise(allInTransaction(database, statements))
  }

  return {
    async createOutbox(input) {
      if ((input.actionTargetType === undefined) !== (input.actionTargetId === undefined)) {
        throw new Error("Delivery target type and ID must be supplied together")
      }
      if (
        input.actionTargetType !== undefined &&
        targets.adapterFor(input.actionTargetType) === undefined
      ) {
        throw new Error(`Unsupported delivery target ${input.actionTargetType}`)
      }
      if (
        (input.conversationTurnId === undefined) !==
        (input.conversationTurnRevision === undefined)
      ) {
        throw new Error("Conversation turn delivery metadata is incomplete")
      }
      const [existing] = await Effect.runPromise(
        database
          .select({ id: outboxMessages.id })
          .from(outboxMessages)
          .where(eq(outboxMessages.idempotencyKey, input.idempotencyKey))
          .limit(1)
      )
      if (existing !== undefined) return existing.id
      const owner = await ownerDataKeys.load(input.ownerId)
      const encrypted = await protection.encryptText(owner.key, input.text)
      const messageId = randomUuid()
      const outboxId = randomUuid()
      const createdAt = now().toISOString()
      await Effect.runPromise(
        allInTransaction(database, [
          database.insert(messages).values({
            id: messageId,
            userId: input.ownerId,
            channelId: input.channelId,
            direction: "outbound",
            textCiphertext: encrypted.ciphertext,
            textIv: encrypted.iv,
            dataKeyVersion: owner.version,
            occurredAt: createdAt,
            createdAt
          }),
          database.insert(outboxMessages).values({
            id: outboxId,
            userId: input.ownerId,
            channelId: input.channelId,
            messageId,
            reasonCode: input.reasonCode,
            correlationId: input.correlationId,
            idempotencyKey: input.idempotencyKey,
            actionTargetType: input.actionTargetType,
            actionTargetId: input.actionTargetId,
            replyToProviderMessageHandle: input.replyToMessageHandle,
            conversationTurnId: input.conversationTurnId,
            conversationTurnRevision: input.conversationTurnRevision,
            dependsOnOutboxId: input.dependsOnOutboxId,
            artifactId: input.artifactId,
            artifactRevision: input.artifactRevision,
            state: "pending",
            createdAt
          })
        ])
      )
      return outboxId
    },

    async markEnqueued(outboxId, at, dispatchGeneration = 0) {
      await Effect.runPromise(
        database
          .update(outboxMessages)
          .set({ enqueuedAt: at })
          .where(
            and(
              eq(outboxMessages.id, outboxId),
              eq(outboxMessages.dispatchGeneration, dispatchGeneration),
              eq(outboxMessages.state, "pending"),
              isNull(outboxMessages.enqueuedAt)
            )
          )
      )
    },

    async claimOutbox(outboxId, leaseMs, dispatchGeneration = 0) {
      const claimedAt = now()
      await this.reconcileExpiredClaims(claimedAt.toISOString())
      const [candidate] = await Effect.runPromise(
        database.select().from(outboxMessages).where(eq(outboxMessages.id, outboxId)).limit(1)
      )
      if (candidate !== undefined && candidate.dispatchGeneration !== dispatchGeneration) {
        return undefined
      }
      if (candidate === undefined || candidate.state !== "pending") {
        await Effect.runPromise(
          database
            .update(outboxMessages)
            .set({ state: "cancelled", completedAt: claimedAt.toISOString() })
            .where(
              and(
                eq(outboxMessages.id, outboxId),
                eq(outboxMessages.state, "pending"),
                sql<boolean>`NOT ${currentConversationReply}`,
                sql<boolean>`NOT ${deferredConversationReply}`
              )
            )
        )
        await Effect.runPromise(
          database
            .update(outboxMessages)
            .set({ state: "cancelled", completedAt: claimedAt.toISOString() })
            .where(
              and(
                eq(outboxMessages.dependsOnOutboxId, outboxId),
                eq(outboxMessages.state, "pending"),
                sql`EXISTS (
                SELECT 1
                FROM outbox_messages AS predecessor
                WHERE predecessor.id = ${outboxId}
                  AND predecessor.state IN ('failed', 'cancelled')
              )`
              )
            )
        )
        return undefined
      }
      const [[message], [channel], attempts] = await Promise.all([
        Effect.runPromise(
          database.select().from(messages).where(eq(messages.id, candidate.messageId)).limit(1)
        ),
        Effect.runPromise(
          database.select().from(channels).where(eq(channels.id, candidate.channelId)).limit(1)
        ),
        Effect.runPromise(
          database
            .select({ count: sql<number>`count(*)` })
            .from(deliveryAttempts)
            .where(eq(deliveryAttempts.outboxId, candidate.id))
        )
      ])
      if (message === undefined || channel === undefined || channel.optedOutAt !== null) {
        const cancelledAt = now().toISOString()
        const cancellationToken = randomUuid()
        const statements: [DatabaseQuery, ...DatabaseQuery[]] = [
          database
            .update(outboxMessages)
            .set({ state: "claimed", claimedAt: cancelledAt, claimToken: cancellationToken })
            .where(
              and(
                eq(outboxMessages.id, candidate.id),
                eq(outboxMessages.state, "pending"),
                currentConversationReply
              )
            ),
          database
            .update(outboxMessages)
            .set({ state: "cancelled", completedAt: cancelledAt, claimToken: null })
            .where(
              and(
                eq(outboxMessages.id, candidate.id),
                eq(outboxMessages.state, "claimed"),
                eq(outboxMessages.claimToken, cancellationToken)
              )
            ),
          database
            .update(outboxMessages)
            .set({ state: "cancelled", completedAt: cancelledAt })
            .where(
              and(
                eq(outboxMessages.dependsOnOutboxId, candidate.id),
                eq(outboxMessages.state, "pending")
              )
            )
        ]
        statements.push(
          ...(await targetStatements({
            outcome: "cancelled",
            targetType: candidate.actionTargetType,
            targetId: candidate.actionTargetId,
            ownerId: candidate.userId,
            messageId: candidate.messageId,
            occurredAt: cancelledAt
          }))
        )
        await Effect.runPromise(allInTransaction(database, statements))
        return undefined
      }
      const attemptId = randomUuid()
      const attemptNumber = Number(attempts[0]?.count ?? 0) + 1
      const key = (await ownerDataKeys.load(candidate.userId)).key
      const [smsSafeText, number, fromNumber] = await Promise.all([
        protection.decryptText(key, { ciphertext: message.textCiphertext, iv: message.textIv }),
        protection.decryptText(key, {
          ciphertext: channel.senderCiphertext,
          iv: channel.senderIv
        }),
        protection.decryptText(key, {
          ciphertext: channel.destinationCiphertext,
          iv: channel.destinationIv
        })
      ])
      const payloadFingerprint = await sha256Hex(smsSafeText)
      const claimExpiresAt = new Date(claimedAt.getTime() + leaseMs).toISOString()
      await Effect.runPromise(
        allInTransaction(database, [
          // This update and the attempt insert share one application storage transaction. The existing trigger
          // closes an exact conversation turn only if the attempt insert can also commit.
          database
            .update(outboxMessages)
            .set({
              state: "claimed",
              claimedAt: claimedAt.toISOString(),
              claimToken: attemptId,
              claimExpiresAt
            })
            .where(
              and(
                eq(outboxMessages.id, outboxId),
                eq(outboxMessages.state, "pending"),
                currentConversationReply
              )
            ),
          database.insert(deliveryAttempts).select(
            database
              .select({
                id: sql<string>`${attemptId}`.as("id"),
                outboxId: outboxMessages.id,
                attemptNumber: sql<number>`${attemptNumber}`.as("attempt_number"),
                state: sql<"sending">`'sending'`.as("state"),
                providerMessageHandle: sql<string | null>`NULL`.as("provider_message_handle"),
                payloadFingerprint: sql<string>`${payloadFingerprint}`.as("payload_fingerprint"),
                errorCode: sql<string | null>`NULL`.as("error_code"),
                startedAt: sql<string>`${claimedAt.toISOString()}`.as("started_at"),
                updatedAt: sql<string>`${claimedAt.toISOString()}`.as("updated_at")
              })
              .from(outboxMessages)
              .where(
                and(
                  eq(outboxMessages.id, outboxId),
                  eq(outboxMessages.state, "claimed"),
                  eq(outboxMessages.claimToken, attemptId)
                )
              )
          )
        ])
      )
      const [attempt] = await Effect.runPromise(
        database
          .select({ id: deliveryAttempts.id })
          .from(deliveryAttempts)
          .where(eq(deliveryAttempts.id, attemptId))
          .limit(1)
      )
      if (attempt === undefined) {
        await Effect.runPromise(
          database
            .update(outboxMessages)
            .set({ state: "cancelled", completedAt: claimedAt.toISOString() })
            .where(
              and(
                eq(outboxMessages.id, outboxId),
                eq(outboxMessages.state, "pending"),
                sql<boolean>`NOT ${currentConversationReply}`,
                sql<boolean>`NOT ${deferredConversationReply}`
              )
            )
        )
        await Effect.runPromise(
          database
            .update(outboxMessages)
            .set({ state: "cancelled", completedAt: claimedAt.toISOString() })
            .where(
              and(
                eq(outboxMessages.dependsOnOutboxId, outboxId),
                eq(outboxMessages.state, "pending"),
                sql`EXISTS (
                SELECT 1
                FROM outbox_messages AS predecessor
                WHERE predecessor.id = ${outboxId}
                  AND predecessor.state IN ('failed', 'cancelled')
              )`
              )
            )
        )
        return undefined
      }
      const claim = {
        outboxId: candidate.id,
        attemptId,
        number,
        fromNumber,
        smsSafeText,
        correlationId: candidate.correlationId,
        claimedAt: claimedAt.toISOString()
      }
      return candidate.replyToProviderMessageHandle === null
        ? claim
        : { ...claim, replyToMessageHandle: candidate.replyToProviderMessageHandle }
    },

    async recordResult(result) {
      const outboxState =
        result.state === "delivered"
          ? "accepted"
          : result.state === "accepted" || result.state === "failed" || result.state === "uncertain"
            ? result.state
            : undefined
      if (outboxState === undefined) throw new Error("Invalid terminal delivery result")
      const [attempt] = await Effect.runPromise(
        database
          .select()
          .from(deliveryAttempts)
          .where(eq(deliveryAttempts.id, result.attemptId))
          .limit(1)
      )
      if (attempt === undefined || attempt.outboxId !== result.outboxId) {
        throw new Error("Delivery attempt does not belong to the outbox")
      }
      const [outbox] = await Effect.runPromise(
        database
          .select()
          .from(outboxMessages)
          .where(eq(outboxMessages.id, result.outboxId))
          .limit(1)
      )
      if (outbox === undefined) throw new Error("Delivery outbox not found")
      const statements: [DatabaseQuery, ...DatabaseQuery[]] = [
        database
          .update(deliveryAttempts)
          .set({
            state: result.state,
            providerMessageHandle: result.providerMessageHandle,
            errorCode: result.errorCode,
            updatedAt: result.occurredAt
          })
          .where(
            and(
              eq(deliveryAttempts.id, result.attemptId),
              inArray(deliveryAttempts.state, ["sending", "accepted", "uncertain"])
            )
          ),
        database
          .update(outboxMessages)
          .set({
            state: outboxState,
            completedAt: result.occurredAt,
            claimExpiresAt: null,
            claimToken: null
          })
          .where(
            and(
              eq(outboxMessages.id, result.outboxId),
              inArray(outboxMessages.state, ["claimed", "accepted", "uncertain"])
            )
          )
      ]
      if (outboxState === "accepted" || outboxState === "failed") {
        statements.push(
          ...(await targetStatements({
            outcome: outboxState,
            targetType: outbox.actionTargetType,
            targetId: outbox.actionTargetId,
            ownerId: outbox.userId,
            messageId: outbox.messageId,
            occurredAt: result.occurredAt
          }))
        )
      }
      if (outboxState === "failed") {
        statements.push(
          database
            .update(outboxMessages)
            .set({ state: "cancelled", completedAt: result.occurredAt })
            .where(
              and(
                eq(outboxMessages.dependsOnOutboxId, outbox.id),
                eq(outboxMessages.state, "pending")
              )
            )
        )
      }
      if (outboxState === "accepted" || outboxState === "failed") {
        statements.push(
          database
            .update(operationalAlerts)
            .set({ state: "resolved", updatedAt: result.occurredAt, resolvedAt: result.occurredAt })
            .where(
              and(
                eq(operationalAlerts.code, "outbound_exhausted"),
                eq(operationalAlerts.objectType, "outbox_message"),
                eq(operationalAlerts.objectId, outbox.id),
                inArray(operationalAlerts.state, ["open", "reconciling"])
              )
            )
        )
      }
      await Effect.runPromise(allInTransaction(database, statements))
      if (outboxState === "uncertain") {
        await recordOperationalAlert(
          database,
          {
            ownerId: outbox.userId,
            code: "delivery_uncertain",
            objectType: "outbox_message",
            objectId: outbox.id,
            idempotencyKey: `alert:delivery-uncertain:${result.attemptId}`
          },
          { now, randomUuid }
        )
      }
      if (result.providerMessageHandle !== undefined) {
        const pendingEvents = await Effect.runPromise(
          database
            .select()
            .from(providerEvents)
            .where(eq(providerEvents.providerMessageHandle, result.providerMessageHandle))
            .orderBy(providerEvents.occurredAt)
        )
        for (const event of pendingEvents) {
          await applyProviderEvent({
            id: event.id,
            accountId: "stored",
            lineId: "stored",
            messageHandle: event.providerMessageHandle,
            status: Schema.decodeUnknownSync(ProviderDeliveryStatus)(event.providerStatus),
            occurredAt: event.occurredAt,
            correlationId: event.correlationId
          })
        }
      }
      const [currentOutbox] = await Effect.runPromise(
        database
          .select({ state: outboxMessages.state })
          .from(outboxMessages)
          .where(eq(outboxMessages.id, outbox.id))
          .limit(1)
      )
      if (currentOutbox?.state !== "accepted") return []
      const followers = await Effect.runPromise(
        database
          .select({ id: outboxMessages.id })
          .from(outboxMessages)
          .where(
            and(
              eq(outboxMessages.dependsOnOutboxId, outbox.id),
              eq(outboxMessages.state, "pending"),
              isNull(outboxMessages.enqueuedAt)
            )
          )
      )
      return followers.map((follower) => follower.id)
    },

    async recordProviderEvent(event) {
      let readyFollowups: readonly string[] = []
      if (event.providerOptedOut || event.status === "opted_out") {
        const destinationHash = await protection.hashLookup(event.destinationE164)
        await Effect.runPromise(
          database
            .update(channels)
            .set({ optedOutAt: event.occurredAt, optedInAt: null })
            .where(
              and(
                eq(channels.provider, options.channelProviderId),
                eq(channels.accountId, event.accountId),
                eq(channels.lineId, event.lineId),
                eq(channels.senderHash, destinationHash)
              )
            )
        )
      }
      const eventKey = `${event.messageHandle}:${event.status}:${event.occurredAt}`
      await Effect.runPromise(
        database
          .insert(providerEvents)
          .values({
            id: event.id,
            provider: options.channelProviderId,
            providerMessageHandle: event.messageHandle,
            providerStatus: event.status,
            providerEventKey: eventKey,
            correlationId: event.correlationId,
            occurredAt: event.occurredAt,
            createdAt: now().toISOString()
          })
          .onConflictDoNothing()
      )

      if (event.outboxId !== undefined && event.attemptId !== undefined) {
        const state =
          event.status === "delivered"
            ? ("delivered" as const)
            : event.status === "declined" ||
                event.status === "error" ||
                event.status === "opted_out"
              ? ("failed" as const)
              : ("accepted" as const)
        const result = {
          outboxId: event.outboxId,
          attemptId: event.attemptId,
          state,
          providerMessageHandle: event.messageHandle,
          occurredAt: event.occurredAt
        }
        readyFollowups = await this.recordResult(
          state === "failed" ? { ...result, errorCode: event.status } : result
        )
      }

      await applyProviderEvent(event)
      return readyFollowups
    },

    async reconcileExpiredClaims(at) {
      const expired = await Effect.runPromise(
        database
          .select({ id: outboxMessages.id, userId: outboxMessages.userId })
          .from(outboxMessages)
          .where(and(eq(outboxMessages.state, "claimed"), lt(outboxMessages.claimExpiresAt, at)))
      )
      for (const item of expired) {
        await Effect.runPromise(
          allInTransaction(database, [
            database
              .update(deliveryAttempts)
              .set({ state: "uncertain", updatedAt: at })
              .where(
                and(
                  eq(deliveryAttempts.outboxId, item.id),
                  inArray(deliveryAttempts.state, ["sending", "accepted"])
                )
              ),
            database
              .update(outboxMessages)
              .set({
                state: "uncertain",
                completedAt: at,
                claimExpiresAt: null,
                claimToken: null
              })
              .where(
                and(
                  eq(outboxMessages.id, item.id),
                  eq(outboxMessages.state, "claimed"),
                  lt(outboxMessages.claimExpiresAt, at)
                )
              )
          ])
        )
        await recordOperationalAlert(
          database,
          {
            ownerId: item.userId,
            code: "delivery_uncertain",
            objectType: "outbox_message",
            objectId: item.id,
            idempotencyKey: `alert:delivery-claim-expired:${item.id}`
          },
          { now, randomUuid }
        )
      }
      return expired.length
    },

    async reconcileOutbox(outboxId) {
      const [outbox] = await Effect.runPromise(
        database
          .select({ state: outboxMessages.state })
          .from(outboxMessages)
          .where(eq(outboxMessages.id, outboxId))
          .limit(1)
      )
      if (outbox === undefined) return "missing"
      if (["accepted", "failed", "cancelled"].includes(outbox.state)) return "resolved"
      const [attempt] = await Effect.runPromise(
        database
          .select()
          .from(deliveryAttempts)
          .where(eq(deliveryAttempts.outboxId, outboxId))
          .orderBy(desc(deliveryAttempts.attemptNumber))
          .limit(1)
      )
      if (attempt?.providerMessageHandle !== null && attempt?.providerMessageHandle !== undefined) {
        const pendingEvents = await Effect.runPromise(
          database
            .select()
            .from(providerEvents)
            .where(eq(providerEvents.providerMessageHandle, attempt.providerMessageHandle))
            .orderBy(providerEvents.occurredAt)
        )
        for (const event of pendingEvents) {
          await applyProviderEvent({
            id: event.id,
            accountId: "stored",
            lineId: "stored",
            messageHandle: event.providerMessageHandle,
            status: Schema.decodeUnknownSync(ProviderDeliveryStatus)(event.providerStatus),
            occurredAt: event.occurredAt,
            correlationId: event.correlationId
          })
        }
      }
      const [updated] = await Effect.runPromise(
        database
          .select({ state: outboxMessages.state })
          .from(outboxMessages)
          .where(eq(outboxMessages.id, outboxId))
          .limit(1)
      )
      return updated !== undefined && ["accepted", "failed", "cancelled"].includes(updated.state)
        ? "resolved"
        : "pending"
    },

    async reconciliationTarget(outboxId) {
      const [target] = await Effect.runPromise(
        database
          .select({
            outboxId: outboxMessages.id,
            attemptId: deliveryAttempts.id,
            correlationId: outboxMessages.correlationId,
            ownerId: outboxMessages.userId,
            providerMessageHandle: deliveryAttempts.providerMessageHandle,
            payloadFingerprint: deliveryAttempts.payloadFingerprint,
            startedAt: deliveryAttempts.startedAt,
            senderCiphertext: channels.senderCiphertext,
            senderIv: channels.senderIv
          })
          .from(outboxMessages)
          .innerJoin(deliveryAttempts, eq(deliveryAttempts.outboxId, outboxMessages.id))
          .innerJoin(channels, eq(channels.id, outboxMessages.channelId))
          .where(
            and(
              eq(outboxMessages.id, outboxId),
              inArray(outboxMessages.state, ["claimed", "accepted", "uncertain"])
            )
          )
          .orderBy(desc(deliveryAttempts.attemptNumber))
          .limit(1)
      )
      if (target === undefined) return undefined
      const identity: DeliveryReconciliationIdentity = {
        outboxId: target.outboxId,
        attemptId: target.attemptId,
        correlationId: target.correlationId
      }
      if (target.providerMessageHandle !== null) {
        return { ...identity, providerMessageHandle: target.providerMessageHandle }
      }
      if (target.payloadFingerprint === null) return undefined
      const destinationE164 = await protection.decryptText(
        (await ownerDataKeys.load(target.ownerId)).key,
        {
          ciphertext: target.senderCiphertext,
          iv: target.senderIv
        }
      )
      const startedAt = Date.parse(target.startedAt)
      return {
        ...identity,
        destinationE164,
        payloadFingerprint: target.payloadFingerprint,
        since: new Date(startedAt - 5 * 60_000).toISOString(),
        until: new Date(startedAt + 20 * 60_000).toISOString()
      }
    },

    async prepareOutboundRecovery(outboxId, maxRecoveries, exhaustedGeneration) {
      const [outbox] = await Effect.runPromise(
        database
          .select({
            state: outboxMessages.state,
            dispatchGeneration: outboxMessages.dispatchGeneration,
            recoveryCount: outboxMessages.recoveryCount,
            enqueuedAt: outboxMessages.enqueuedAt,
            deadLetteredAt: outboxMessages.deadLetteredAt
          })
          .from(outboxMessages)
          .where(eq(outboxMessages.id, outboxId))
          .limit(1)
      )
      if (outbox === undefined) return { status: "missing" }
      if (["accepted", "failed", "cancelled"].includes(outbox.state)) {
        return { status: "resolved" }
      }
      if (outbox.state !== "pending") return { status: "unsafe" }
      const [attempt] = await Effect.runPromise(
        database
          .select({ id: deliveryAttempts.id })
          .from(deliveryAttempts)
          .where(eq(deliveryAttempts.outboxId, outboxId))
          .limit(1)
      )
      if (attempt !== undefined) return { status: "unsafe" }

      if (exhaustedGeneration === undefined) {
        if (outbox.enqueuedAt !== null) return { status: "active" }
        if (outbox.recoveryCount > 0) {
          return { status: "recover", dispatchGeneration: outbox.dispatchGeneration }
        }
      } else if (outbox.dispatchGeneration !== exhaustedGeneration) {
        if (outbox.dispatchGeneration === exhaustedGeneration + 1 && outbox.enqueuedAt === null) {
          return { status: "recover", dispatchGeneration: outbox.dispatchGeneration }
        }
        return { status: "active" }
      }

      if (outbox.recoveryCount >= maxRecoveries) return { status: "limit" }
      const recoveredAt = now().toISOString()
      const [updated] = await Effect.runPromise(
        database
          .update(outboxMessages)
          .set({
            deadLetteredAt: recoveredAt,
            enqueuedAt: null,
            dispatchGeneration: outbox.dispatchGeneration + 1,
            recoveryCount: outbox.recoveryCount + 1
          })
          .where(
            and(
              eq(outboxMessages.id, outboxId),
              eq(outboxMessages.state, "pending"),
              eq(outboxMessages.dispatchGeneration, outbox.dispatchGeneration),
              eq(outboxMessages.recoveryCount, outbox.recoveryCount),
              sql<boolean>`NOT EXISTS (
              SELECT 1 FROM ${deliveryAttempts}
              WHERE ${deliveryAttempts.outboxId} = ${outboxId}
            )`
            )
          )
          .returning({ dispatchGeneration: outboxMessages.dispatchGeneration })
      )
      return updated === undefined
        ? { status: "unsafe" }
        : { status: "recover", dispatchGeneration: updated.dispatchGeneration }
    },

    async outboxDisposition(outboxId, dispatchGeneration) {
      const [outbox] = await Effect.runPromise(
        database
          .select({
            state: outboxMessages.state,
            dispatchGeneration: outboxMessages.dispatchGeneration
          })
          .from(outboxMessages)
          .where(eq(outboxMessages.id, outboxId))
          .limit(1)
      )
      if (outbox === undefined) return "missing"
      if (dispatchGeneration !== undefined && dispatchGeneration !== outbox.dispatchGeneration) {
        return "complete"
      }
      return outbox.state === "pending" || outbox.state === "claimed" ? "active" : "complete"
    }
  }
}

export function deliveryStoreLayer(store: DeliveryStoreAdapter) {
  return Layer.succeed(
    DeliveryStore,
    liftPromiseAdapter(
      store,
      (operation, cause) => new DeliveryStoreError({ operation: String(operation), cause })
    )
  )
}
