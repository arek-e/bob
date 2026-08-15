import type { InboundAcceptance, NormalizedInboundEvent } from "@bob/contracts/channel"
import type { BatchItem } from "drizzle-orm/batch"

import { and, eq, gt, isNull, lt, or, sql } from "drizzle-orm"
import { Context, Layer } from "effect"

import type { CoreDatabase } from "../../database.ts"
import type { DataProtection } from "../policy/data-protection.ts"

import { channels, inboundEvents, messages, shortReplyBindings, users } from "./schema.ts"

export interface ClaimedInbound {
  readonly eventId: string
  readonly ownerId: string
  readonly channelId: string
  readonly messageId: string
  readonly text: string
  readonly providerMessageHandle: string
  readonly service: NormalizedInboundEvent["service"]
  readonly isGroup: boolean
  readonly number: string
  readonly fromNumber: string
  readonly correlationId: string
}

export interface ConversationStore {
  acceptInbound(event: NormalizedInboundEvent): Promise<InboundAcceptance>
  markEnqueued(eventId: string, at: string): Promise<void>
  getInboundOwner(eventId: string): Promise<string | undefined>
  claimInbound(eventId: string, leaseMs: number): Promise<ClaimedInbound | undefined>
  claimReaction(eventId: string, at: string): Promise<boolean>
  completeInbound(eventId: string, at: string): Promise<void>
  prepareInboundRecovery(
    eventId: string,
    maxRecoveries: number
  ): Promise<"recover" | "complete" | "exhausted" | "missing">
  pendingBindings(
    ownerId: string,
    command: string,
    now: string
  ): Promise<
    readonly {
      id: string
      command: string
      targetType: string
      targetId: string
      expiresAt: string
    }[]
  >
}

export const ConversationStore = Context.Service<ConversationStore>("bob/ConversationStore")

export interface ConversationStoreOptions {
  readonly ownerId: string
  readonly ownerTimeZone: string
  readonly dataKeyVersion: number
  readonly now?: () => Date
  readonly randomUuid?: () => string
}

export function makeConversationStore(
  database: CoreDatabase,
  protection: DataProtection,
  options: ConversationStoreOptions
): ConversationStore {
  const now = options.now ?? (() => new Date())
  const randomUuid = options.randomUuid ?? (() => crypto.randomUUID())

  async function ownerKey(): Promise<CryptoKey> {
    let [owner] = await database.select().from(users).where(eq(users.id, options.ownerId)).limit(1)
    if (owner?.wrappedDataKey === null || owner?.wrappedDataKey === undefined) {
      const created = await protection.createWrappedDataKey()
      const timestamp = now().toISOString()
      if (owner === undefined) {
        await database
          .insert(users)
          .values({
            id: options.ownerId,
            timeZone: options.ownerTimeZone,
            wrappedDataKey: created.wrapped.ciphertext,
            wrappedDataKeyIv: created.wrapped.iv,
            dataKeyVersion: created.wrapped.version,
            createdAt: timestamp,
            updatedAt: timestamp
          })
          .onConflictDoNothing()
      } else {
        await database
          .update(users)
          .set({
            wrappedDataKey: created.wrapped.ciphertext,
            wrappedDataKeyIv: created.wrapped.iv,
            dataKeyVersion: created.wrapped.version,
            updatedAt: timestamp
          })
          .where(and(eq(users.id, options.ownerId), isNull(users.wrappedDataKey)))
      }
      ;[owner] = await database.select().from(users).where(eq(users.id, options.ownerId)).limit(1)
    }
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

  async function ensureChannel(event: NormalizedInboundEvent, key: CryptoKey): Promise<string> {
    const senderHash = await protection.hashLookup(event.senderE164)
    const destinationHash = await protection.hashLookup(event.destinationE164)
    let [channel] = await database
      .select({ id: channels.id })
      .from(channels)
      .where(
        and(
          eq(channels.provider, "sendblue"),
          eq(channels.accountId, event.accountId),
          eq(channels.lineId, event.lineId),
          eq(channels.senderHash, senderHash)
        )
      )
      .limit(1)
    if (channel !== undefined) return channel.id

    const sender = await protection.encryptText(key, event.senderE164)
    const destination = await protection.encryptText(key, event.destinationE164)
    const id = randomUuid()
    await database
      .insert(channels)
      .values({
        id,
        userId: options.ownerId,
        provider: "sendblue",
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
    ;[channel] = await database
      .select({ id: channels.id })
      .from(channels)
      .where(
        and(
          eq(channels.provider, "sendblue"),
          eq(channels.accountId, event.accountId),
          eq(channels.lineId, event.lineId),
          eq(channels.senderHash, senderHash)
        )
      )
      .limit(1)
    if (channel === undefined) throw new Error("Channel creation failed")
    return channel.id
  }

  return {
    async acceptInbound(event) {
      const [existing] = await database
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
      if (existing !== undefined) {
        return {
          eventId: existing.id,
          duplicate: true,
          shouldEnqueue: existing.enqueuedAt === null && existing.processedAt === null
        }
      }

      const key = await ownerKey()
      const channelId = await ensureChannel(event, key)
      const encrypted = await protection.encryptText(key, event.text)
      const messageId = randomUuid()
      const createdAt = now().toISOString()
      const control = event.text.trim().toUpperCase()
      const optOutControl = event.providerOptedOut || control === "STOP" || control === "CANCEL"
      const optInControl = !event.providerOptedOut && control === "START"
      const consumedControl = optOutControl || optInControl
      const statements: [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]] = [
        database.insert(messages).values({
          id: messageId,
          userId: options.ownerId,
          channelId,
          direction: "inbound",
          textCiphertext: encrypted.ciphertext,
          textIv: encrypted.iv,
          dataKeyVersion: options.dataKeyVersion,
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
        await database.batch(statements)
      } catch {
        const [winner] = await database
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
      await database
        .update(inboundEvents)
        .set({ enqueuedAt: at })
        .where(and(eq(inboundEvents.id, eventId), isNull(inboundEvents.enqueuedAt)))
    },

    async getInboundOwner(eventId) {
      const [event] = await database
        .select({ ownerId: inboundEvents.userId, processedAt: inboundEvents.processedAt })
        .from(inboundEvents)
        .where(eq(inboundEvents.id, eventId))
        .limit(1)
      return event?.processedAt === null ? event.ownerId : undefined
    },

    async claimInbound(eventId, leaseMs) {
      const claimedAt = now()
      const claimExpiresAt = new Date(claimedAt.getTime() + leaseMs)
      const [claimed] = await database
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
      if (claimed === undefined) return undefined
      const [[message], [channel]] = await Promise.all([
        database.select().from(messages).where(eq(messages.id, claimed.messageId)).limit(1),
        database.select().from(channels).where(eq(channels.id, claimed.channelId)).limit(1)
      ])
      if (message === undefined || channel === undefined) {
        throw new Error("Inbound message or channel is missing")
      }
      const key = await ownerKey()
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
      const [claimed] = await database
        .update(inboundEvents)
        .set({ reactionClaimedAt: at })
        .where(and(eq(inboundEvents.id, eventId), isNull(inboundEvents.reactionClaimedAt)))
        .returning({ id: inboundEvents.id })
      return claimed !== undefined
    },

    async completeInbound(eventId, at) {
      await database
        .update(inboundEvents)
        .set({ processedAt: at, claimExpiresAt: null })
        .where(eq(inboundEvents.id, eventId))
    },

    async prepareInboundRecovery(eventId, maxRecoveries) {
      const [recovered] = await database
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
      if (recovered !== undefined) return "recover"
      const [event] = await database
        .select({ processedAt: inboundEvents.processedAt })
        .from(inboundEvents)
        .where(eq(inboundEvents.id, eventId))
        .limit(1)
      if (event === undefined) return "missing"
      return event.processedAt === null ? "exhausted" : "complete"
    },

    async pendingBindings(ownerId, command, at) {
      return database
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
    }
  }
}

export function conversationStoreLayer(store: ConversationStore) {
  return Layer.succeed(ConversationStore, store)
}
