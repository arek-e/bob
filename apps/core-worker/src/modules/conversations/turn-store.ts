import { and, asc, eq, isNull, lte, ne, or, sql } from "drizzle-orm"
import { Context, Layer } from "effect"

import type { CoreDatabase } from "../../database.ts"
import type { DataProtection } from "../policy/data-protection.ts"

import {
  channels,
  conversationTurnMessages,
  conversationTurns,
  inboundEvents,
  messages,
  users
} from "./schema.ts"
import { conversationTiming } from "./timing.ts"

export interface OfferedConversationTurn {
  readonly turnId: string
  readonly revision: number
  readonly status: "collecting" | "running" | "settling" | "committing" | "replied"
  readonly quietUntil: string
  readonly appended: boolean
  readonly activeRunId?: string
}

export interface SettlingConversationTurn {
  readonly claimExpiresAt: string
}

export interface ConversationTurnStore {
  offer(inboundEventId: string, traceparent?: string): Promise<OfferedConversationTurn>
  claimReady(turnId?: string, leaseMs?: number): Promise<ConversationTurnSnapshot | undefined>
  nextWakeAt(): Promise<string | undefined>
  currentRevision(turnId: string): Promise<number | undefined>
  markRunning(turnId: string, revision: number, runId: string): Promise<boolean>
  markSettling(
    turnId: string,
    latestRevision: number,
    activeRunId: string
  ): Promise<SettlingConversationTurn | undefined>
  releaseSettling(
    turnId: string,
    activeRunId: string
  ): Promise<{ readonly ready: boolean; readonly quietUntil?: string }>
  releaseSettlingForRun(
    activeRunId: string
  ): Promise<{ readonly ownerId: string; readonly quietUntil: string } | undefined>
  commitReply(
    turnId: string,
    revision: number,
    runId: string,
    outboxId: string
  ): Promise<"committed" | "superseded">
  markEventsProcessed(turnId: string, revision: number): Promise<number>
}

export interface ConversationTurnMessage {
  readonly eventId: string
  readonly messageId: string
  readonly text: string
  readonly ordinal: number
}

export interface ConversationTurnLatest extends ConversationTurnMessage {
  readonly providerMessageHandle: string
  readonly service: "imessage" | "sms" | "rcs" | "unknown"
  readonly isGroup: boolean
  readonly correlationId: string
  readonly number: string
  readonly fromNumber: string
  readonly traceparent?: string
}

export interface ConversationTurnSnapshot {
  readonly turnId: string
  readonly ownerId: string
  readonly channelId: string
  readonly revision: number
  readonly claimExpiresAt: string
  readonly latest: ConversationTurnLatest
  readonly messages: readonly ConversationTurnMessage[]
}

export const ConversationTurnStore = Context.Service<ConversationTurnStore>(
  "bob/ConversationTurnStore"
)

export interface ConversationTurnStoreOptions {
  readonly ownerId: string
  readonly quietWindowMs?: number
  readonly burstWindowMs?: number
  readonly claimLeaseMs?: number
  readonly settleLeaseMs?: number
  readonly now?: () => Date
  readonly randomUuid?: () => string
}

export function makeConversationTurnStore(
  database: CoreDatabase,
  protection: DataProtection,
  options: ConversationTurnStoreOptions
): ConversationTurnStore {
  const quietWindowMs = options.quietWindowMs ?? 1_500
  const burstWindowMs = options.burstWindowMs ?? 5_000
  const claimLeaseMs = options.claimLeaseMs ?? conversationTiming.activeLeaseMs
  const settleLeaseMs = options.settleLeaseMs ?? conversationTiming.mutationSettleLeaseMs
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

  return {
    async offer(inboundEventId, traceparent) {
      while (true) {
        const [existingMembership] = await database
          .select({
            turnId: conversationTurnMessages.turnId,
            revision: conversationTurnMessages.revision
          })
          .from(conversationTurnMessages)
          .where(eq(conversationTurnMessages.inboundEventId, inboundEventId))
          .limit(1)
        if (existingMembership !== undefined) {
          const [turn] = await database
            .select()
            .from(conversationTurns)
            .where(eq(conversationTurns.id, existingMembership.turnId))
            .limit(1)
          if (turn === undefined) throw new Error("Conversation turn membership is orphaned")
          const offered = {
            turnId: turn.id,
            revision: turn.revision,
            status: turn.status,
            quietUntil: turn.quietUntil,
            appended: false
          }
          return turn.activeRunId === null ? offered : { ...offered, activeRunId: turn.activeRunId }
        }

        const [event] = await database
          .select({
            ownerId: inboundEvents.userId,
            channelId: inboundEvents.channelId,
            messageId: inboundEvents.messageId
          })
          .from(inboundEvents)
          .where(eq(inboundEvents.id, inboundEventId))
          .limit(1)
        if (event === undefined) throw new Error("Inbound event not found")

        const at = now()
        const createdAt = at.toISOString()
        const turnId = randomUuid()
        const quietUntil = new Date(at.getTime() + quietWindowMs).toISOString()
        const burstExpiresAt = new Date(at.getTime() + burstWindowMs).toISOString()
        try {
          await database.batch([
            database.insert(conversationTurns).values({
              id: turnId,
              userId: event.ownerId,
              channelId: event.channelId,
              status: "collecting",
              revision: 1,
              latestInboundEventId: inboundEventId,
              latestMessageId: event.messageId,
              quietUntil,
              burstExpiresAt,
              createdAt,
              updatedAt: createdAt
            }),
            database.insert(conversationTurnMessages).values({
              turnId,
              inboundEventId,
              messageId: event.messageId,
              ordinal: 1,
              revision: 1,
              traceparent,
              createdAt
            })
          ])
        } catch {
          const [winner] = await database
            .select()
            .from(conversationTurns)
            .where(
              and(
                eq(conversationTurns.userId, event.ownerId),
                eq(conversationTurns.channelId, event.channelId),
                ne(conversationTurns.status, "replied")
              )
            )
            .limit(1)
          if (winner === undefined) throw new Error("Conversation turn creation failed")
          const revision = winner.revision + 1
          const appendedStatus: "collecting" | "settling" =
            winner.activeRunId === null ? "collecting" : "settling"
          const winnerQuietUntil = new Date(
            Math.min(at.getTime() + quietWindowMs, Date.parse(winner.burstExpiresAt))
          ).toISOString()
          await database.batch([
            database
              .update(conversationTurns)
              .set({
                status: appendedStatus,
                revision,
                latestInboundEventId: inboundEventId,
                latestMessageId: event.messageId,
                replyOutboxId: null,
                quietUntil: winnerQuietUntil,
                updatedAt: createdAt
              })
              .where(
                and(
                  eq(conversationTurns.id, winner.id),
                  eq(conversationTurns.revision, winner.revision),
                  ne(conversationTurns.status, "replied")
                )
              ),
            database.insert(conversationTurnMessages).select(
              database
                .select({
                  turnId: sql<string>`${winner.id}`.as("turn_id"),
                  inboundEventId: sql<string>`${inboundEventId}`.as("inbound_event_id"),
                  messageId: sql<string>`${event.messageId}`.as("message_id"),
                  ordinal: sql<number>`${revision}`.as("ordinal"),
                  revision: sql<number>`${revision}`.as("revision"),
                  traceparent: sql<string | null>`${traceparent ?? null}`.as("traceparent"),
                  createdAt: sql<string>`${createdAt}`.as("created_at")
                })
                .from(conversationTurns)
                .where(
                  and(
                    eq(conversationTurns.id, winner.id),
                    eq(conversationTurns.revision, revision),
                    eq(conversationTurns.status, appendedStatus),
                    eq(conversationTurns.latestInboundEventId, inboundEventId)
                  )
                )
            )
          ])
          const [appendedMembership] = await database
            .select({ turnId: conversationTurnMessages.turnId })
            .from(conversationTurnMessages)
            .where(eq(conversationTurnMessages.inboundEventId, inboundEventId))
            .limit(1)
          if (appendedMembership === undefined) continue
          const offered = {
            turnId: winner.id,
            revision,
            status: appendedStatus,
            quietUntil: winnerQuietUntil,
            appended: true
          }
          return winner.activeRunId === null
            ? offered
            : { ...offered, activeRunId: winner.activeRunId }
        }
        return { turnId, revision: 1, status: "collecting", quietUntil, appended: true }
      }
    },

    async claimReady(turnId?: string, leaseMs = claimLeaseMs) {
      const at = now()
      await database
        .update(conversationTurns)
        .set({
          status: "collecting",
          activeRunId: null,
          activeRunRevision: null,
          claimedRevision: null,
          claimedAt: null,
          claimExpiresAt: null,
          quietUntil: sql`max(${conversationTurns.quietUntil}, ${at.toISOString()})`,
          updatedAt: at.toISOString()
        })
        .where(
          and(
            eq(conversationTurns.userId, options.ownerId),
            eq(conversationTurns.status, "settling"),
            lte(conversationTurns.claimExpiresAt, at.toISOString())
          )
        )
      const expiresAt = new Date(at.getTime() + leaseMs).toISOString()
      let selectedTurnId = turnId
      if (selectedTurnId === undefined) {
        const [ready] = await database
          .select({ id: conversationTurns.id })
          .from(conversationTurns)
          .where(
            and(
              eq(conversationTurns.userId, options.ownerId),
              sql`${conversationTurns.status} NOT IN ('settling', 'committing', 'replied')`,
              lte(conversationTurns.quietUntil, at.toISOString()),
              or(
                isNull(conversationTurns.claimExpiresAt),
                lte(conversationTurns.claimExpiresAt, at.toISOString()),
                isNull(conversationTurns.claimedRevision),
                sql`${conversationTurns.claimedRevision} <> ${conversationTurns.revision}`
              )
            )
          )
          .orderBy(asc(conversationTurns.quietUntil))
          .limit(1)
        selectedTurnId = ready?.id
      }
      if (selectedTurnId === undefined) return undefined
      const [claimed] = await database
        .update(conversationTurns)
        .set({
          claimedRevision: sql`${conversationTurns.revision}`,
          claimedAt: at.toISOString(),
          claimExpiresAt: expiresAt
        })
        .where(
          and(
            eq(conversationTurns.id, selectedTurnId),
            eq(conversationTurns.userId, options.ownerId),
            sql`${conversationTurns.status} NOT IN ('settling', 'committing', 'replied')`,
            lte(conversationTurns.quietUntil, at.toISOString()),
            or(
              isNull(conversationTurns.claimExpiresAt),
              lte(conversationTurns.claimExpiresAt, at.toISOString()),
              isNull(conversationTurns.claimedRevision),
              sql`${conversationTurns.claimedRevision} <> ${conversationTurns.revision}`
            )
          )
        )
        .returning()
      if (claimed === undefined) return undefined

      const rows = await database
        .select({
          eventId: conversationTurnMessages.inboundEventId,
          messageId: conversationTurnMessages.messageId,
          ordinal: conversationTurnMessages.ordinal,
          textCiphertext: messages.textCiphertext,
          textIv: messages.textIv,
          providerMessageHandle: inboundEvents.providerMessageHandle,
          service: inboundEvents.service,
          isGroup: inboundEvents.isGroup,
          correlationId: inboundEvents.correlationId,
          traceparent: conversationTurnMessages.traceparent
        })
        .from(conversationTurnMessages)
        .innerJoin(messages, eq(conversationTurnMessages.messageId, messages.id))
        .innerJoin(inboundEvents, eq(conversationTurnMessages.inboundEventId, inboundEvents.id))
        .where(
          and(
            eq(conversationTurnMessages.turnId, selectedTurnId),
            lte(conversationTurnMessages.revision, claimed.revision)
          )
        )
        .orderBy(asc(messages.occurredAt), asc(messages.createdAt), asc(messages.id))
      const key = await ownerKey(claimed.userId)
      const [channel] = await database
        .select({
          senderCiphertext: channels.senderCiphertext,
          senderIv: channels.senderIv,
          destinationCiphertext: channels.destinationCiphertext,
          destinationIv: channels.destinationIv
        })
        .from(channels)
        .where(eq(channels.id, claimed.channelId))
        .limit(1)
      if (channel === undefined) throw new Error("Conversation turn channel is missing")
      const [decrypted, number, fromNumber] = await Promise.all([
        Promise.all(
          rows.map(async (row) => ({
            ...row,
            text: await protection.decryptText(key, {
              ciphertext: row.textCiphertext,
              iv: row.textIv
            })
          }))
        ),
        protection.decryptText(key, {
          ciphertext: channel.senderCiphertext,
          iv: channel.senderIv
        }),
        protection.decryptText(key, {
          ciphertext: channel.destinationCiphertext,
          iv: channel.destinationIv
        })
      ])
      const ordered = decrypted.map((row, index) => ({ ...row, ordinal: index + 1 }))
      const latest = ordered.at(-1)
      if (latest === undefined) throw new Error("Conversation turn target is missing")
      const latestMessage = {
        eventId: latest.eventId,
        messageId: latest.messageId,
        text: latest.text,
        ordinal: latest.ordinal,
        providerMessageHandle: latest.providerMessageHandle,
        service: latest.service,
        isGroup: latest.isGroup,
        correlationId: latest.correlationId,
        number,
        fromNumber
      }
      const latestWithTrace =
        latest.traceparent === null
          ? latestMessage
          : { ...latestMessage, traceparent: latest.traceparent }
      return {
        turnId: claimed.id,
        ownerId: claimed.userId,
        channelId: claimed.channelId,
        revision: claimed.revision,
        claimExpiresAt: expiresAt,
        latest: latestWithTrace,
        messages: ordered.map((row) => ({
          eventId: row.eventId,
          messageId: row.messageId,
          text: row.text,
          ordinal: row.ordinal
        }))
      }
    },

    async nextWakeAt() {
      const open = await database
        .select({
          status: conversationTurns.status,
          revision: conversationTurns.revision,
          quietUntil: conversationTurns.quietUntil,
          claimedRevision: conversationTurns.claimedRevision,
          claimExpiresAt: conversationTurns.claimExpiresAt
        })
        .from(conversationTurns)
        .where(
          and(
            eq(conversationTurns.userId, options.ownerId),
            sql`${conversationTurns.status} NOT IN ('committing', 'replied')`
          )
        )
      return open.reduce<string | undefined>((earliest, turn) => {
        const candidate =
          turn.status === "settling" || turn.claimedRevision === turn.revision
            ? (turn.claimExpiresAt ?? turn.quietUntil)
            : turn.quietUntil
        return earliest === undefined || Date.parse(candidate) < Date.parse(earliest)
          ? candidate
          : earliest
      }, undefined)
    },

    async currentRevision(turnId) {
      const [turn] = await database
        .select({ revision: conversationTurns.revision })
        .from(conversationTurns)
        .where(eq(conversationTurns.id, turnId))
        .limit(1)
      return turn?.revision
    },

    async markRunning(turnId, revision, runId) {
      const at = now()
      const renewedClaimExpiresAt = new Date(at.getTime() + claimLeaseMs).toISOString()
      const [running] = await database
        .update(conversationTurns)
        .set({
          status: "running",
          activeRunId: runId,
          activeRunRevision: revision,
          claimExpiresAt: sql`max(coalesce(${conversationTurns.claimExpiresAt}, ${renewedClaimExpiresAt}), ${renewedClaimExpiresAt})`,
          updatedAt: at.toISOString()
        })
        .where(
          and(
            eq(conversationTurns.id, turnId),
            eq(conversationTurns.revision, revision),
            eq(conversationTurns.claimedRevision, revision),
            ne(conversationTurns.status, "replied"),
            or(
              isNull(conversationTurns.activeRunId),
              isNull(conversationTurns.activeRunRevision),
              sql`${conversationTurns.activeRunRevision} < ${revision}`,
              and(
                eq(conversationTurns.activeRunRevision, revision),
                eq(conversationTurns.activeRunId, runId)
              )
            )
          )
        )
        .returning({ id: conversationTurns.id })
      return running !== undefined
    },

    async markSettling(turnId, latestRevision, activeRunId) {
      const at = now()
      const minimumExpiresAt = new Date(at.getTime() + settleLeaseMs).toISOString()
      const [settling] = await database
        .update(conversationTurns)
        .set({
          status: "settling",
          claimExpiresAt: sql`max(coalesce(${conversationTurns.claimExpiresAt}, ${minimumExpiresAt}), ${minimumExpiresAt})`,
          updatedAt: at.toISOString()
        })
        .where(
          and(
            eq(conversationTurns.id, turnId),
            eq(conversationTurns.revision, latestRevision),
            eq(conversationTurns.activeRunId, activeRunId),
            ne(conversationTurns.status, "replied")
          )
        )
        .returning({ claimExpiresAt: conversationTurns.claimExpiresAt })
      return settling?.claimExpiresAt === null || settling === undefined
        ? undefined
        : { claimExpiresAt: settling.claimExpiresAt }
    },

    async releaseSettling(turnId, activeRunId) {
      const at = now()
      const [turn] = await database
        .select({ quietUntil: conversationTurns.quietUntil })
        .from(conversationTurns)
        .where(
          and(
            eq(conversationTurns.id, turnId),
            eq(conversationTurns.activeRunId, activeRunId),
            eq(conversationTurns.status, "settling")
          )
        )
        .limit(1)
      if (turn === undefined) return { ready: false }
      const quietUntil = new Date(Math.max(at.getTime(), Date.parse(turn.quietUntil))).toISOString()
      const [released] = await database
        .update(conversationTurns)
        .set({
          status: "collecting",
          activeRunId: null,
          activeRunRevision: null,
          claimedRevision: null,
          claimedAt: null,
          claimExpiresAt: null,
          quietUntil,
          updatedAt: at.toISOString()
        })
        .where(
          and(
            eq(conversationTurns.id, turnId),
            eq(conversationTurns.activeRunId, activeRunId),
            eq(conversationTurns.status, "settling")
          )
        )
        .returning({ id: conversationTurns.id })
      return released === undefined ? { ready: false } : { ready: true, quietUntil }
    },

    async releaseSettlingForRun(activeRunId) {
      const at = now().toISOString()
      const [released] = await database
        .update(conversationTurns)
        .set({
          status: "collecting",
          activeRunId: null,
          activeRunRevision: null,
          claimedRevision: null,
          claimedAt: null,
          claimExpiresAt: null,
          quietUntil: sql`max(${conversationTurns.quietUntil}, ${at})`,
          updatedAt: at
        })
        .where(
          and(
            eq(conversationTurns.activeRunId, activeRunId),
            eq(conversationTurns.status, "settling")
          )
        )
        .returning({
          ownerId: conversationTurns.userId,
          quietUntil: conversationTurns.quietUntil
        })
      return released
    },

    async commitReply(turnId, revision, runId, outboxId) {
      const at = now().toISOString()
      const [committed] = await database
        .update(conversationTurns)
        .set({
          status: "committing",
          replyOutboxId: outboxId,
          activeRunId: null,
          activeRunRevision: null,
          updatedAt: at,
          claimExpiresAt: null
        })
        .where(
          and(
            eq(conversationTurns.id, turnId),
            eq(conversationTurns.revision, revision),
            eq(conversationTurns.activeRunId, runId),
            eq(conversationTurns.claimedRevision, revision),
            eq(conversationTurns.status, "running")
          )
        )
        .returning({ id: conversationTurns.id })
      if (committed !== undefined) return "committed"
      const [priorCommit] = await database
        .select({ id: conversationTurns.id })
        .from(conversationTurns)
        .where(
          and(
            eq(conversationTurns.id, turnId),
            eq(conversationTurns.revision, revision),
            eq(conversationTurns.replyOutboxId, outboxId),
            eq(conversationTurns.status, "committing")
          )
        )
        .limit(1)
      return priorCommit === undefined ? "superseded" : "committed"
    },

    async markEventsProcessed(turnId, revision) {
      const at = now().toISOString()
      const [committed] = await database
        .select({ id: conversationTurns.id })
        .from(conversationTurns)
        .where(
          and(
            eq(conversationTurns.id, turnId),
            eq(conversationTurns.revision, revision),
            or(eq(conversationTurns.status, "committing"), eq(conversationTurns.status, "replied"))
          )
        )
        .limit(1)
      if (committed === undefined) return 0
      const memberships = database
        .select({ eventId: conversationTurnMessages.inboundEventId })
        .from(conversationTurnMessages)
        .where(
          and(
            eq(conversationTurnMessages.turnId, turnId),
            lte(conversationTurnMessages.revision, revision)
          )
        )
      const processed = await database
        .update(inboundEvents)
        .set({ processedAt: at, claimExpiresAt: null })
        .where(and(sql`${inboundEvents.id} IN ${memberships}`, isNull(inboundEvents.processedAt)))
        .returning({ id: inboundEvents.id })
      return processed.length
    }
  }
}

export function conversationTurnStoreLayer(store: ConversationTurnStore) {
  return Layer.succeed(ConversationTurnStore, store)
}
