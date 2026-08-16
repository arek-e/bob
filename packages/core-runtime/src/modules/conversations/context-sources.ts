import type { ContextItem } from "@bob/contracts/agent"

import {
  conversationTurnMessages,
  conversationTurns,
  inboundEvents,
  messages
} from "@bob/db/schema/conversations"
import { deliveryAttempts, outboxMessages } from "@bob/db/schema/delivery"
import { and, asc, desc, eq, gte, inArray, isNotNull, lte, ne } from "drizzle-orm"

import type { CoreDatabase } from "../../database.ts"
import type { PrivateTextReader } from "../context/private-text.ts"
import type { ContextSourceModule } from "../context/source.ts"

import { approvedContextItem, boundContextItems } from "../context/source.ts"

function sourceDay(value: string): string {
  return value.slice(0, 10)
}

export function makeConversationContextSources(
  database: CoreDatabase,
  text: PrivateTextReader,
  options: { readonly itemCharacterBudget?: number } = {}
): readonly ContextSourceModule[] {
  const itemCharacterBudget = options.itemCharacterBudget ?? 1_200
  const inlineReply: ContextSourceModule = {
    id: "inline_reply",
    async load(input) {
      const [parent] = await database
        .select({
          id: messages.id,
          textCiphertext: messages.textCiphertext,
          textIv: messages.textIv,
          occurredAt: messages.occurredAt
        })
        .from(inboundEvents)
        .innerJoin(
          deliveryAttempts,
          eq(deliveryAttempts.providerMessageHandle, inboundEvents.replyToProviderMessageHandle)
        )
        .innerJoin(
          outboxMessages,
          and(
            eq(outboxMessages.id, deliveryAttempts.outboxId),
            eq(outboxMessages.userId, input.ownerId),
            eq(outboxMessages.channelId, input.channelId),
            eq(outboxMessages.state, "accepted")
          )
        )
        .innerJoin(
          conversationTurns,
          and(
            eq(conversationTurns.id, outboxMessages.conversationTurnId),
            eq(conversationTurns.revision, outboxMessages.conversationTurnRevision),
            eq(conversationTurns.contextEligible, true)
          )
        )
        .innerJoin(
          messages,
          and(eq(messages.id, outboxMessages.messageId), eq(messages.direction, "outbound"))
        )
        .where(
          and(
            eq(inboundEvents.userId, input.ownerId),
            eq(inboundEvents.channelId, input.channelId),
            eq(inboundEvents.messageId, input.currentMessageId),
            isNotNull(inboundEvents.replyToProviderMessageHandle),
            inArray(deliveryAttempts.state, ["accepted", "delivered"])
          )
        )
        .orderBy(desc(deliveryAttempts.updatedAt))
        .limit(1)
      if (parent === undefined) return []
      const value = await text.decrypt(input.ownerId, {
        ciphertext: parent.textCiphertext,
        iv: parent.textIv
      })
      return [
        approvedContextItem({
          kind: "conversation",
          text: `Bob (message replied to): ${value}`,
          instruction: false,
          conflict: false,
          sources: [
            {
              sourceId: parent.id,
              sourceLabel: `Bob reply ${sourceDay(parent.occurredAt)}`,
              occurredAt: parent.occurredAt
            }
          ]
        })
      ]
    }
  }

  const recentConversation: ContextSourceModule = {
    id: "conversation",
    deduplicateAgainst: ["inline_reply"],
    async load(input) {
      if (input.currentConversationTurnId === undefined) return []
      const deliveredAfter = new Date(Date.parse(input.localTime) - 15 * 60_000).toISOString()
      const priorTurns = await database
        .select({
          id: conversationTurns.id,
          revision: conversationTurns.revision,
          outboundMessageId: outboxMessages.messageId
        })
        .from(conversationTurns)
        .innerJoin(
          outboxMessages,
          and(
            eq(outboxMessages.id, conversationTurns.replyOutboxId),
            eq(outboxMessages.conversationTurnId, conversationTurns.id),
            eq(outboxMessages.conversationTurnRevision, conversationTurns.revision),
            eq(outboxMessages.state, "accepted")
          )
        )
        .innerJoin(
          deliveryAttempts,
          and(
            eq(deliveryAttempts.outboxId, outboxMessages.id),
            eq(deliveryAttempts.state, "delivered")
          )
        )
        .where(
          and(
            eq(conversationTurns.userId, input.ownerId),
            eq(conversationTurns.channelId, input.channelId),
            eq(conversationTurns.status, "replied"),
            eq(conversationTurns.contextEligible, true),
            ne(conversationTurns.id, input.currentConversationTurnId),
            gte(deliveryAttempts.updatedAt, deliveredAfter),
            lte(deliveryAttempts.updatedAt, input.localTime)
          )
        )
        .orderBy(desc(deliveryAttempts.updatedAt))
        .limit(4)

      const newest: ContextItem[] = []
      let messageCount = 0
      for (const turn of priorTurns) {
        const remaining = 6 - messageCount
        if (remaining < 2) break
        const inbound = await database
          .select({
            id: messages.id,
            textCiphertext: messages.textCiphertext,
            textIv: messages.textIv,
            occurredAt: messages.occurredAt
          })
          .from(conversationTurnMessages)
          .innerJoin(messages, eq(messages.id, conversationTurnMessages.messageId))
          .where(
            and(
              eq(conversationTurnMessages.turnId, turn.id),
              lte(conversationTurnMessages.revision, turn.revision),
              eq(messages.direction, "inbound")
            )
          )
          .orderBy(asc(messages.occurredAt), asc(messages.createdAt), asc(messages.id))
        const [outbound] = await database
          .select({
            id: messages.id,
            textCiphertext: messages.textCiphertext,
            textIv: messages.textIv,
            occurredAt: messages.occurredAt
          })
          .from(messages)
          .where(and(eq(messages.id, turn.outboundMessageId), eq(messages.direction, "outbound")))
          .limit(1)
        if (inbound.length === 0 || outbound === undefined) continue
        const selected = inbound.slice(-(remaining - 1))
        const [inboundText, outboundText] = await Promise.all([
          Promise.all(
            selected.map((message) =>
              text.decrypt(input.ownerId, {
                ciphertext: message.textCiphertext,
                iv: message.textIv
              })
            )
          ),
          text.decrypt(input.ownerId, {
            ciphertext: outbound.textCiphertext,
            iv: outbound.textIv
          })
        ])
        messageCount += selected.length + 1
        newest.push({
          kind: "conversation" as const,
          text: [...inboundText.map((value) => `Owner: ${value}`), `Bob: ${outboundText}`].join(
            "\n"
          ),
          instruction: false,
          conflict: false,
          sources: [
            ...selected.map((message) => ({
              sourceId: message.id,
              sourceLabel: `owner message ${sourceDay(message.occurredAt)}`,
              occurredAt: message.occurredAt
            })),
            {
              sourceId: outbound.id,
              sourceLabel: `Bob reply ${sourceDay(outbound.occurredAt)}`,
              occurredAt: outbound.occurredAt
            }
          ]
        })
      }
      return boundContextItems(newest, 2_400, itemCharacterBudget)
        .toReversed()
        .map(approvedContextItem)
    }
  }
  return Object.freeze([inlineReply, recentConversation])
}
