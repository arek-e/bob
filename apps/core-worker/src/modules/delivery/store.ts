import type { DeliveryResult, OutboxClaim } from "@bob/contracts/delivery"
import type { NormalizedStatusEvent } from "@bob/contracts/channel"
import { and, desc, eq, inArray, isNull, lt, sql } from "drizzle-orm"
import type { BatchItem } from "drizzle-orm/batch"
import { Context, Layer } from "effect"

import type { CoreDatabase } from "../../database.ts"
import { operationalAlerts } from "../alerts/schema.ts"
import { recordOperationalAlert } from "../alerts/store.ts"
import { channels, messages, shortReplyBindings, users } from "../conversations/schema.ts"
import type { DataProtection } from "../policy/data-protection.ts"
import { reminderOccurrences } from "../reminders/schema.ts"
import { deliveryAttempts, outboxMessages, providerEvents } from "./schema.ts"

export interface CreateOutboxInput {
  readonly ownerId: string
  readonly channelId: string
  readonly text: string
  readonly reasonCode: string
  readonly correlationId: string
  readonly idempotencyKey: string
  readonly actionTargetType?: "reminder_occurrence"
  readonly actionTargetId?: string
}

export interface DeliveryStore {
  createOutbox(input: CreateOutboxInput): Promise<string>
  markEnqueued(outboxId: string, at: string): Promise<void>
  claimOutbox(outboxId: string, leaseMs: number): Promise<OutboxClaim | undefined>
  recordResult(result: DeliveryResult): Promise<void>
  recordProviderEvent(event: NormalizedStatusEvent): Promise<void>
  reconcileExpiredClaims(at: string): Promise<number>
  reconcileOutbox(outboxId: string): Promise<"resolved" | "pending" | "missing">
  outboxDisposition(outboxId: string): Promise<"active" | "complete" | "missing">
}

export const DeliveryStore = Context.Service<DeliveryStore>("bob/DeliveryStore")

export function makeDeliveryStore(
  database: CoreDatabase,
  protection: DataProtection,
  options: { readonly now?: () => Date; readonly randomUuid?: () => string }
): DeliveryStore {
  const now = options.now ?? (() => new Date())
  const randomUuid = options.randomUuid ?? (() => crypto.randomUUID())

  async function ownerKey(ownerId: string): Promise<CryptoKey> {
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
    return protection.unwrapDataKey({
      ciphertext: owner.wrappedDataKey,
      iv: owner.wrappedDataKeyIv,
      version: owner.dataKeyVersion
    })
  }

  type ApplicableStatusEvent = Omit<NormalizedStatusEvent, "destinationE164" | "providerOptedOut">

  async function applyProviderEvent(event: ApplicableStatusEvent): Promise<void> {
    const [attempt] = await database
      .select()
      .from(deliveryAttempts)
      .where(eq(deliveryAttempts.providerMessageHandle, event.messageHandle))
      .limit(1)
    if (attempt === undefined) return
    const [outbox] = await database
      .select()
      .from(outboxMessages)
      .where(eq(outboxMessages.id, attempt.outboxId))
      .limit(1)
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
    const statements: [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]] = [
      database
        .update(deliveryAttempts)
        .set({ ...(canAdvance ? { state: next } : {}), updatedAt: event.occurredAt })
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
      if (
        next === "failed" &&
        outbox.actionTargetType === "reminder_occurrence" &&
        outbox.actionTargetId !== null
      ) {
        statements.push(
          database
            .update(reminderOccurrences)
            .set({ state: "missed", updatedAt: event.occurredAt })
            .where(
              and(
                eq(reminderOccurrences.id, outbox.actionTargetId),
                inArray(reminderOccurrences.state, ["awaiting_delivery", "awaiting_response"])
              )
            ),
          database
            .update(shortReplyBindings)
            .set({ consumedAt: event.occurredAt })
            .where(
              and(
                eq(shortReplyBindings.targetType, "reminder"),
                eq(shortReplyBindings.targetId, outbox.actionTargetId),
                isNull(shortReplyBindings.consumedAt)
              )
            ),
          database
            .insert(operationalAlerts)
            .values({
              id: randomUuid(),
              userId: outbox.userId,
              code: "reminder_missed",
              objectType: "reminder_occurrence",
              objectId: outbox.actionTargetId,
              idempotencyKey: `alert:reminder-delivery-failed:${outbox.actionTargetId}`,
              state: "open",
              createdAt: event.occurredAt,
              updatedAt: event.occurredAt
            })
            .onConflictDoNothing()
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
    await database.batch(statements)
  }

  return {
    async createOutbox(input) {
      const [existing] = await database
        .select({ id: outboxMessages.id })
        .from(outboxMessages)
        .where(eq(outboxMessages.idempotencyKey, input.idempotencyKey))
        .limit(1)
      if (existing !== undefined) return existing.id
      const [owner] = await database
        .select({ dataKeyVersion: users.dataKeyVersion })
        .from(users)
        .where(eq(users.id, input.ownerId))
        .limit(1)
      if (owner?.dataKeyVersion === null || owner?.dataKeyVersion === undefined) {
        throw new Error("Owner data key version is unavailable")
      }
      const encrypted = await protection.encryptText(await ownerKey(input.ownerId), input.text)
      const messageId = randomUuid()
      const outboxId = randomUuid()
      const createdAt = now().toISOString()
      await database.batch([
        database.insert(messages).values({
          id: messageId,
          userId: input.ownerId,
          channelId: input.channelId,
          direction: "outbound",
          textCiphertext: encrypted.ciphertext,
          textIv: encrypted.iv,
          dataKeyVersion: owner.dataKeyVersion,
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
          state: "pending",
          createdAt
        })
      ])
      return outboxId
    },

    async markEnqueued(outboxId, at) {
      await database
        .update(outboxMessages)
        .set({ enqueuedAt: at })
        .where(and(eq(outboxMessages.id, outboxId), isNull(outboxMessages.enqueuedAt)))
    },

    async claimOutbox(outboxId, leaseMs) {
      const claimedAt = now()
      await this.reconcileExpiredClaims(claimedAt.toISOString())
      const [claimed] = await database
        .update(outboxMessages)
        .set({
          state: "claimed",
          claimedAt: claimedAt.toISOString(),
          claimExpiresAt: new Date(claimedAt.getTime() + leaseMs).toISOString()
        })
        .where(and(eq(outboxMessages.id, outboxId), eq(outboxMessages.state, "pending")))
        .returning()
      if (claimed === undefined) return undefined

      const [[message], [channel], attempts] = await Promise.all([
        database.select().from(messages).where(eq(messages.id, claimed.messageId)).limit(1),
        database.select().from(channels).where(eq(channels.id, claimed.channelId)).limit(1),
        database
          .select({ count: sql<number>`count(*)` })
          .from(deliveryAttempts)
          .where(eq(deliveryAttempts.outboxId, claimed.id))
      ])
      if (message === undefined || channel === undefined || channel.optedOutAt !== null) {
        const cancelledAt = now().toISOString()
        const statements: [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]] = [
          database
            .update(outboxMessages)
            .set({ state: "cancelled", completedAt: cancelledAt })
            .where(eq(outboxMessages.id, claimed.id))
        ]
        if (claimed.actionTargetType === "reminder_occurrence" && claimed.actionTargetId !== null) {
          statements.push(
            database
              .update(reminderOccurrences)
              .set({ state: "cancelled", updatedAt: cancelledAt })
              .where(
                and(
                  eq(reminderOccurrences.id, claimed.actionTargetId),
                  inArray(reminderOccurrences.state, ["claimed", "awaiting_delivery"])
                )
              ),
            database
              .update(shortReplyBindings)
              .set({ consumedAt: cancelledAt })
              .where(
                and(
                  eq(shortReplyBindings.targetType, "reminder"),
                  eq(shortReplyBindings.targetId, claimed.actionTargetId),
                  isNull(shortReplyBindings.consumedAt)
                )
              )
          )
        }
        await database.batch(statements)
        return undefined
      }
      const attemptId = randomUuid()
      const attemptNumber = Number(attempts[0]?.count ?? 0) + 1
      await database.insert(deliveryAttempts).values({
        id: attemptId,
        outboxId: claimed.id,
        attemptNumber,
        state: "sending",
        startedAt: claimedAt.toISOString(),
        updatedAt: claimedAt.toISOString()
      })
      const key = await ownerKey(claimed.userId)
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
      return {
        outboxId: claimed.id,
        attemptId,
        number,
        fromNumber,
        smsSafeText,
        correlationId: claimed.correlationId,
        claimedAt: claimedAt.toISOString()
      } as OutboxClaim
    },

    async recordResult(result) {
      const outboxState =
        result.state === "delivered"
          ? "accepted"
          : result.state === "accepted" || result.state === "failed" || result.state === "uncertain"
            ? result.state
            : undefined
      if (outboxState === undefined) throw new Error("Invalid terminal delivery result")
      const [attempt] = await database
        .select()
        .from(deliveryAttempts)
        .where(eq(deliveryAttempts.id, result.attemptId))
        .limit(1)
      if (attempt === undefined || attempt.outboxId !== result.outboxId) {
        throw new Error("Delivery attempt does not belong to the outbox")
      }
      const [outbox] = await database
        .select()
        .from(outboxMessages)
        .where(eq(outboxMessages.id, result.outboxId))
        .limit(1)
      if (outbox === undefined) throw new Error("Delivery outbox not found")
      const statements: [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]] = [
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
            claimExpiresAt: null
          })
          .where(
            and(
              eq(outboxMessages.id, result.outboxId),
              inArray(outboxMessages.state, ["claimed", "accepted", "uncertain"])
            )
          )
      ]
      if (
        outboxState === "accepted" &&
        outbox.actionTargetType === "reminder_occurrence" &&
        outbox.actionTargetId !== null
      ) {
        const [occurrence] = await database
          .select({
            responseDeadlineAt: reminderOccurrences.responseDeadlineAt,
            state: reminderOccurrences.state
          })
          .from(reminderOccurrences)
          .where(eq(reminderOccurrences.id, outbox.actionTargetId))
          .limit(1)
        if (
          occurrence?.responseDeadlineAt !== null &&
          occurrence?.responseDeadlineAt !== undefined &&
          occurrence.state === "awaiting_delivery" &&
          Date.parse(occurrence.responseDeadlineAt) > Date.parse(result.occurredAt)
        ) {
          statements.push(
            database
              .update(reminderOccurrences)
              .set({ state: "awaiting_response", updatedAt: result.occurredAt })
              .where(
                and(
                  eq(reminderOccurrences.id, outbox.actionTargetId),
                  eq(reminderOccurrences.state, "awaiting_delivery")
                )
              ),
            database
              .insert(shortReplyBindings)
              .values({
                id: randomUuid(),
                userId: outbox.userId,
                outboundMessageId: outbox.messageId,
                command: "seen",
                targetType: "reminder",
                targetId: outbox.actionTargetId,
                expiresAt: occurrence.responseDeadlineAt,
                createdAt: result.occurredAt
              })
              .onConflictDoNothing(),
            database
              .insert(shortReplyBindings)
              .values({
                id: randomUuid(),
                userId: outbox.userId,
                outboundMessageId: outbox.messageId,
                command: "done",
                targetType: "reminder",
                targetId: outbox.actionTargetId,
                expiresAt: occurrence.responseDeadlineAt,
                createdAt: result.occurredAt
              })
              .onConflictDoNothing()
          )
        }
      }
      if (
        outboxState === "failed" &&
        outbox.actionTargetType === "reminder_occurrence" &&
        outbox.actionTargetId !== null
      ) {
        statements.push(
          database
            .update(reminderOccurrences)
            .set({ state: "missed", updatedAt: result.occurredAt })
            .where(
              and(
                eq(reminderOccurrences.id, outbox.actionTargetId),
                inArray(reminderOccurrences.state, ["awaiting_delivery", "awaiting_response"])
              )
            ),
          database
            .update(shortReplyBindings)
            .set({ consumedAt: result.occurredAt })
            .where(
              and(
                eq(shortReplyBindings.targetType, "reminder"),
                eq(shortReplyBindings.targetId, outbox.actionTargetId),
                isNull(shortReplyBindings.consumedAt)
              )
            ),
          database
            .insert(operationalAlerts)
            .values({
              id: randomUuid(),
              userId: outbox.userId,
              code: "reminder_missed",
              objectType: "reminder_occurrence",
              objectId: outbox.actionTargetId,
              idempotencyKey: `alert:reminder-delivery-failed:${outbox.actionTargetId}`,
              state: "open",
              createdAt: result.occurredAt,
              updatedAt: result.occurredAt
            })
            .onConflictDoNothing()
        )
      }
      await database.batch(statements)
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
        const pendingEvents = await database
          .select()
          .from(providerEvents)
          .where(eq(providerEvents.providerMessageHandle, result.providerMessageHandle))
          .orderBy(providerEvents.occurredAt)
        for (const event of pendingEvents) {
          await applyProviderEvent({
            id: event.id,
            accountId: "stored",
            lineId: "stored",
            messageHandle: event.providerMessageHandle,
            status: event.providerStatus as NormalizedStatusEvent["status"],
            occurredAt: event.occurredAt,
            correlationId: event.correlationId
          })
        }
      }
    },

    async recordProviderEvent(event) {
      if (event.providerOptedOut || event.status === "opted_out") {
        const destinationHash = await protection.hashLookup(event.destinationE164)
        await database
          .update(channels)
          .set({ optedOutAt: event.occurredAt, optedInAt: null })
          .where(
            and(
              eq(channels.provider, "sendblue"),
              eq(channels.accountId, event.accountId),
              eq(channels.lineId, event.lineId),
              eq(channels.senderHash, destinationHash)
            )
          )
      }
      const eventKey = `${event.messageHandle}:${event.status}:${event.occurredAt}`
      await database
        .insert(providerEvents)
        .values({
          id: event.id,
          provider: "sendblue",
          providerMessageHandle: event.messageHandle,
          providerStatus: event.status,
          providerEventKey: eventKey,
          correlationId: event.correlationId,
          occurredAt: event.occurredAt,
          createdAt: now().toISOString()
        })
        .onConflictDoNothing()

      if (event.outboxId !== undefined && event.attemptId !== undefined) {
        const state =
          event.status === "delivered"
            ? ("delivered" as const)
            : event.status === "declined" ||
                event.status === "error" ||
                event.status === "opted_out"
              ? ("failed" as const)
              : ("accepted" as const)
        await this.recordResult({
          outboxId: event.outboxId,
          attemptId: event.attemptId,
          state,
          providerMessageHandle: event.messageHandle,
          ...(state === "failed" ? { errorCode: event.status } : {}),
          occurredAt: event.occurredAt
        })
      }

      await applyProviderEvent(event)
    },

    async reconcileExpiredClaims(at) {
      const expired = await database
        .select({ id: outboxMessages.id, userId: outboxMessages.userId })
        .from(outboxMessages)
        .where(and(eq(outboxMessages.state, "claimed"), lt(outboxMessages.claimExpiresAt, at)))
      for (const item of expired) {
        await database.batch([
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
            .set({ state: "uncertain", completedAt: at, claimExpiresAt: null })
            .where(
              and(
                eq(outboxMessages.id, item.id),
                eq(outboxMessages.state, "claimed"),
                lt(outboxMessages.claimExpiresAt, at)
              )
            )
        ])
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
      const [outbox] = await database
        .select({ state: outboxMessages.state })
        .from(outboxMessages)
        .where(eq(outboxMessages.id, outboxId))
        .limit(1)
      if (outbox === undefined) return "missing"
      if (["accepted", "failed", "cancelled"].includes(outbox.state)) return "resolved"
      const [attempt] = await database
        .select()
        .from(deliveryAttempts)
        .where(eq(deliveryAttempts.outboxId, outboxId))
        .orderBy(desc(deliveryAttempts.attemptNumber))
        .limit(1)
      if (attempt?.providerMessageHandle !== null && attempt?.providerMessageHandle !== undefined) {
        const pendingEvents = await database
          .select()
          .from(providerEvents)
          .where(eq(providerEvents.providerMessageHandle, attempt.providerMessageHandle))
          .orderBy(providerEvents.occurredAt)
        for (const event of pendingEvents) {
          await applyProviderEvent({
            id: event.id,
            accountId: "stored",
            lineId: "stored",
            messageHandle: event.providerMessageHandle,
            status: event.providerStatus as NormalizedStatusEvent["status"],
            occurredAt: event.occurredAt,
            correlationId: event.correlationId
          })
        }
      }
      const [updated] = await database
        .select({ state: outboxMessages.state })
        .from(outboxMessages)
        .where(eq(outboxMessages.id, outboxId))
        .limit(1)
      return updated !== undefined && ["accepted", "failed", "cancelled"].includes(updated.state)
        ? "resolved"
        : "pending"
    },

    async outboxDisposition(outboxId) {
      const [outbox] = await database
        .select({ state: outboxMessages.state })
        .from(outboxMessages)
        .where(eq(outboxMessages.id, outboxId))
        .limit(1)
      if (outbox === undefined) return "missing"
      return outbox.state === "pending" || outbox.state === "claimed" ? "active" : "complete"
    }
  }
}

export function deliveryStoreLayer(store: DeliveryStore) {
  return Layer.succeed(DeliveryStore, store)
}
