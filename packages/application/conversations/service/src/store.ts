import type { NormalizedInboundEvent } from "@bob/conversations-types/channel"
import type { ConversationStoreAdapter } from "@bob/conversations-types/store"
import type { CoreDatabase, DatabaseQuery } from "@bob/db-types"
import type { DataProtection } from "@bob/policy-types/data-protection"
import type { OwnerDataKeyStoreAdapter } from "@bob/policy-types/owner-data-key"

import { ConversationStore, ConversationStoreError } from "@bob/conversations-types/store"
import {
  channels,
  inboundEvents,
  messages,
  shortReplyBindings
} from "@bob/db-service/schema/conversations"
import { allInTransaction } from "@bob/db-types"
import { makeOwnerDataKeyStore } from "@bob/policy-service/owner-data-key"
import { liftPromiseAdapter } from "@bob/shared-types/effect-adapter"
import { and, eq, gt, isNull, lt, or, sql } from "drizzle-orm"
import { Effect, Layer } from "effect"

export { ConversationStore }
export type { ClaimedInbound, ConversationStoreAdapter } from "@bob/conversations-types/store"

export interface ConversationStoreOptions {
  readonly ownerId: string
  readonly ownerTimeZone: string
  readonly ownerDataKeys?: OwnerDataKeyStoreAdapter
  readonly channelProviderId: string
  readonly now?: () => Date
  readonly randomUuid?: () => string
}

export function makeConversationStore(
  database: CoreDatabase,
  protection: DataProtection,
  options: ConversationStoreOptions
): ConversationStoreAdapter {
  const now = options.now ?? (() => new Date())
  const randomUuid = options.randomUuid ?? (() => crypto.randomUUID())
  const ownerDataKeys =
    options.ownerDataKeys ??
    makeOwnerDataKeyStore(database, protection, { defaultTimeZone: options.ownerTimeZone, now })

  async function ensureChannel(event: NormalizedInboundEvent, key: CryptoKey): Promise<string> {
    const senderHash = await protection.hashLookup(event.senderE164)
    const destinationHash = await protection.hashLookup(event.destinationE164)
    let [channel] = await Effect.runPromise(
      database
        .select({ id: channels.id })
        .from(channels)
        .where(
          and(
            eq(channels.provider, options.channelProviderId),
            eq(channels.accountId, event.accountId),
            eq(channels.lineId, event.lineId),
            eq(channels.senderHash, senderHash)
          )
        )
        .limit(1)
    )
    if (channel !== undefined) return channel.id

    const sender = await protection.encryptText(key, event.senderE164)
    const destination = await protection.encryptText(key, event.destinationE164)
    const id = randomUuid()
    await Effect.runPromise(
      database
        .insert(channels)
        .values({
          id,
          userId: options.ownerId,
          provider: options.channelProviderId,
          accountId: event.accountId,
          lineId: event.lineId,
          senderHash,
          senderCiphertext: sender.ciphertext,
          senderIv: sender.iv,
          destinationHash,
          destinationCiphertext: destination.ciphertext,
          destinationIv: destination.iv,
          createdAt: now().toISOString()
        })
        .onConflictDoNothing()
    )
    ;[channel] = await Effect.runPromise(
      database
        .select({ id: channels.id })
        .from(channels)
        .where(
          and(
            eq(channels.provider, options.channelProviderId),
            eq(channels.accountId, event.accountId),
            eq(channels.lineId, event.lineId),
            eq(channels.senderHash, senderHash)
          )
        )
        .limit(1)
    )
    if (channel === undefined) throw new Error("Channel creation failed")
    return channel.id
  }

  return {
    async acceptInbound(event) {
      const [existing] = await Effect.runPromise(
        database
          .select({
            id: inboundEvents.id,
            enqueuedAt: inboundEvents.enqueuedAt,
            processedAt: inboundEvents.processedAt
          })
          .from(inboundEvents)
          .where(
            and(
              eq(inboundEvents.accountId, event.accountId),
              eq(inboundEvents.lineId, event.lineId),
              eq(inboundEvents.providerMessageHandle, event.messageHandle)
            )
          )
          .limit(1)
      )
      if (existing !== undefined) {
        return {
          eventId: existing.id,
          duplicate: true,
          shouldEnqueue: existing.enqueuedAt === null && existing.processedAt === null
        }
      }

      const ownerDataKey = await ownerDataKeys.ensure(options.ownerId)
      const channelId = await ensureChannel(event, ownerDataKey.key)
      const encrypted = await protection.encryptText(ownerDataKey.key, event.text)
      const messageId = randomUuid()
      const createdAt = now().toISOString()
      const control = event.text.trim().toUpperCase()
      const optOutControl = event.providerOptedOut || control === "STOP" || control === "CANCEL"
      const optInControl = !event.providerOptedOut && control === "START"
      const consumedControl = optOutControl || optInControl
      const statements: [DatabaseQuery, ...DatabaseQuery[]] = [
        database.insert(messages).values({
          id: messageId,
          userId: options.ownerId,
          channelId,
          direction: "inbound",
          textCiphertext: encrypted.ciphertext,
          textIv: encrypted.iv,
          dataKeyVersion: ownerDataKey.version,
          occurredAt: event.receivedAt,
          createdAt
        }),
        database.insert(inboundEvents).values({
          id: event.id,
          userId: options.ownerId,
          channelId,
          messageId,
          accountId: event.accountId,
          lineId: event.lineId,
          providerMessageHandle: event.messageHandle,
          replyToProviderMessageHandle: event.replyToMessageHandle,
          service: event.service,
          isGroup: event.isGroup,
          correlationId: event.correlationId,
          processedAt: consumedControl ? createdAt : null,
          createdAt
        })
      ]
      if (optOutControl) {
        statements.push(
          database
            .update(channels)
            .set({ optedOutAt: event.receivedAt, optedInAt: null })
            .where(eq(channels.id, channelId))
        )
      } else if (optInControl) {
        statements.push(
          database
            .update(channels)
            .set({ optedOutAt: null, optedInAt: event.receivedAt })
            .where(eq(channels.id, channelId))
        )
      }
      try {
        await Effect.runPromise(allInTransaction(database, statements))
      } catch {
        const [winner] = await Effect.runPromise(
          database
            .select({
              id: inboundEvents.id,
              enqueuedAt: inboundEvents.enqueuedAt,
              processedAt: inboundEvents.processedAt
            })
            .from(inboundEvents)
            .where(
              and(
                eq(inboundEvents.accountId, event.accountId),
                eq(inboundEvents.lineId, event.lineId),
                eq(inboundEvents.providerMessageHandle, event.messageHandle)
              )
            )
            .limit(1)
        )
        if (winner === undefined) throw new Error("Inbound event insert failed")
        return {
          eventId: winner.id,
          duplicate: true,
          shouldEnqueue: winner.enqueuedAt === null && winner.processedAt === null
        }
      }
      return {
        eventId: event.id,
        duplicate: false,
        shouldEnqueue: !consumedControl
      }
    },

    async markEnqueued(eventId, at) {
      await Effect.runPromise(
        database
          .update(inboundEvents)
          .set({ enqueuedAt: at })
          .where(and(eq(inboundEvents.id, eventId), isNull(inboundEvents.enqueuedAt)))
      )
    },

    async getInboundOwner(eventId) {
      const [event] = await Effect.runPromise(
        database
          .select({ ownerId: inboundEvents.userId, processedAt: inboundEvents.processedAt })
          .from(inboundEvents)
          .where(eq(inboundEvents.id, eventId))
          .limit(1)
      )
      return event?.processedAt === null ? event.ownerId : undefined
    },

    async claimInbound(eventId, leaseMs) {
      const claimedAt = now()
      const claimExpiresAt = new Date(claimedAt.getTime() + leaseMs)
      const [claimed] = await Effect.runPromise(
        database
          .update(inboundEvents)
          .set({ claimedAt: claimedAt.toISOString(), claimExpiresAt: claimExpiresAt.toISOString() })
          .where(
            and(
              eq(inboundEvents.id, eventId),
              isNull(inboundEvents.processedAt),
              or(
                isNull(inboundEvents.claimExpiresAt),
                lt(inboundEvents.claimExpiresAt, claimedAt.toISOString())
              )
            )
          )
          .returning()
      )
      if (claimed === undefined) return undefined
      const [[message], [channel]] = await Promise.all([
        Effect.runPromise(
          database.select().from(messages).where(eq(messages.id, claimed.messageId)).limit(1)
        ),
        Effect.runPromise(
          database.select().from(channels).where(eq(channels.id, claimed.channelId)).limit(1)
        )
      ])
      if (message === undefined || channel === undefined) {
        throw new Error("Inbound message or channel is missing")
      }
      const key = (await ownerDataKeys.load(claimed.userId)).key
      const [text, number, fromNumber] = await Promise.all([
        protection.decryptText(key, {
          ciphertext: message.textCiphertext,
          iv: message.textIv
        }),
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
        eventId: claimed.id,
        ownerId: claimed.userId,
        channelId: claimed.channelId,
        messageId: claimed.messageId,
        text,
        providerMessageHandle: claimed.providerMessageHandle,
        service: claimed.service,
        isGroup: claimed.isGroup,
        number,
        fromNumber,
        correlationId: claimed.correlationId
      }
    },

    async claimReaction(eventId, at) {
      const [claimed] = await Effect.runPromise(
        database
          .update(inboundEvents)
          .set({ reactionClaimedAt: at })
          .where(and(eq(inboundEvents.id, eventId), isNull(inboundEvents.reactionClaimedAt)))
          .returning({ id: inboundEvents.id })
      )
      return claimed !== undefined
    },

    async completeInbound(eventId, at) {
      await Effect.runPromise(
        database
          .update(inboundEvents)
          .set({ processedAt: at, claimExpiresAt: null })
          .where(eq(inboundEvents.id, eventId))
      )
    },

    async prepareInboundRecovery(eventId, maxRecoveries) {
      const [recovered] = await Effect.runPromise(
        database
          .update(inboundEvents)
          .set({
            deadLetteredAt: now().toISOString(),
            recoveryCount: sql`${inboundEvents.recoveryCount} + 1`,
            enqueuedAt: null,
            claimedAt: null,
            claimExpiresAt: null
          })
          .where(
            and(
              eq(inboundEvents.id, eventId),
              isNull(inboundEvents.processedAt),
              lt(inboundEvents.recoveryCount, maxRecoveries)
            )
          )
          .returning({ id: inboundEvents.id })
      )
      if (recovered !== undefined) return "recover"
      const [event] = await Effect.runPromise(
        database
          .select({ processedAt: inboundEvents.processedAt })
          .from(inboundEvents)
          .where(eq(inboundEvents.id, eventId))
          .limit(1)
      )
      if (event === undefined) return "missing"
      return event.processedAt === null ? "exhausted" : "complete"
    },

    async pendingBindings(ownerId, command, at) {
      return Effect.runPromise(
        database
          .select({
            id: shortReplyBindings.id,
            command: shortReplyBindings.command,
            targetType: shortReplyBindings.targetType,
            targetId: shortReplyBindings.targetId,
            expiresAt: shortReplyBindings.expiresAt
          })
          .from(shortReplyBindings)
          .where(
            and(
              eq(shortReplyBindings.userId, ownerId),
              eq(shortReplyBindings.command, command),
              isNull(shortReplyBindings.consumedAt),
              gt(shortReplyBindings.expiresAt, at)
            )
          )
      )
    }
  }
}

export function conversationStoreLayer(store: ConversationStoreAdapter) {
  return Layer.succeed(
    ConversationStore,
    liftPromiseAdapter(
      store,
      (operation, cause) => new ConversationStoreError({ operation: String(operation), cause })
    )
  )
}
