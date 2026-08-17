import type { PrivateTextReader } from "@bob/context-service/private-text"
import type { PriorToolReceiptSource } from "@bob/context-service/store"
import type { CoreDatabase } from "@bob/db-types"

import { PriorToolReceipt } from "@bob/agent-types/run"
import { agentRuns, conversationTurns, toolCalls } from "@bob/db-service/schema/conversations"
import { outboxMessages } from "@bob/db-service/schema/delivery"
import { ToolName, ToolResult } from "@bob/tools-types/tools"
import { and, desc, eq, gte, inArray, isNotNull, lt, lte, ne, or } from "drizzle-orm"
import { Effect, Schema } from "effect"

const PrivateEnvelope = Schema.Struct({ ciphertext: Schema.String, iv: Schema.String })

export function makePriorToolReceiptSource(
  database: CoreDatabase,
  text: PrivateTextReader
): PriorToolReceiptSource {
  return {
    async load(input) {
      if (
        input.currentConversationTurnId === undefined ||
        input.currentConversationTurnRevision === undefined
      ) {
        return []
      }
      const [currentTurn] = await Effect.runPromise(
        database
          .select({ createdAt: conversationTurns.createdAt })
          .from(conversationTurns)
          .where(
            and(
              eq(conversationTurns.id, input.currentConversationTurnId),
              eq(conversationTurns.userId, input.ownerId),
              eq(conversationTurns.channelId, input.channelId)
            )
          )
          .limit(1)
      )
      const predecessorBefore =
        currentTurn === undefined || Date.parse(currentTurn.createdAt) > Date.parse(input.localTime)
          ? input.localTime
          : currentTurn.createdAt
      const predecessorAfter = new Date(Date.parse(input.localTime) - 15 * 60_000).toISOString()
      const [predecessor] =
        currentTurn === undefined
          ? []
          : await Effect.runPromise(
              database
                .select({ id: conversationTurns.id, revision: conversationTurns.revision })
                .from(conversationTurns)
                .innerJoin(
                  outboxMessages,
                  and(
                    eq(outboxMessages.id, conversationTurns.replyOutboxId),
                    eq(outboxMessages.conversationTurnId, conversationTurns.id),
                    eq(outboxMessages.conversationTurnRevision, conversationTurns.revision)
                  )
                )
                .where(
                  and(
                    eq(conversationTurns.userId, input.ownerId),
                    eq(conversationTurns.channelId, input.channelId),
                    eq(conversationTurns.status, "replied"),
                    ne(conversationTurns.id, input.currentConversationTurnId),
                    isNotNull(conversationTurns.repliedAt),
                    gte(conversationTurns.repliedAt, predecessorAfter),
                    lte(conversationTurns.repliedAt, predecessorBefore)
                  )
                )
                .orderBy(desc(conversationTurns.repliedAt), desc(conversationTurns.updatedAt))
                .limit(1)
            )
      const currentRevision = and(
        eq(agentRuns.conversationTurnId, input.currentConversationTurnId),
        lt(agentRuns.conversationTurnRevision, input.currentConversationTurnRevision)
      )
      const authority =
        predecessor === undefined
          ? currentRevision
          : or(
              currentRevision,
              and(
                eq(agentRuns.conversationTurnId, predecessor.id),
                eq(agentRuns.conversationTurnRevision, predecessor.revision)
              )
            )
      const rows = await Effect.runPromise(
        database
          .select({
            conversationTurnId: agentRuns.conversationTurnId,
            toolName: toolCalls.toolName,
            resultJson: toolCalls.resultJson
          })
          .from(toolCalls)
          .innerJoin(agentRuns, eq(agentRuns.id, toolCalls.runId))
          .where(
            and(
              eq(agentRuns.userId, input.ownerId),
              authority,
              inArray(toolCalls.status, ["completed", "failed", "unknown"]),
              isNotNull(toolCalls.resultJson)
            )
          )
          .orderBy(desc(toolCalls.completedAt), desc(toolCalls.createdAt))
          .limit(8)
      )
      const receipts = []
      for (const row of rows.toReversed()) {
        try {
          if (row.resultJson === null) continue
          const envelope = Schema.decodeUnknownSync(PrivateEnvelope)(JSON.parse(row.resultJson))
          const result = Schema.decodeUnknownSync(ToolResult)(
            JSON.parse(await text.decrypt(input.ownerId, envelope))
          )
          const actionOutcome =
            result.evidence?.actionOutcome ??
            (result.code === "tool_recovery_failed" ? "unknown" : undefined)
          if (actionOutcome === undefined) continue
          receipts.push(
            Schema.decodeUnknownSync(PriorToolReceipt)({
              origin:
                row.conversationTurnId === input.currentConversationTurnId
                  ? "same_turn"
                  : "predecessor_turn",
              toolName: Schema.decodeUnknownSync(ToolName)(row.toolName),
              actionOutcome
            })
          )
        } catch {
          // Malformed private receipts never enter an Agent request.
        }
      }
      return receipts
    }
  }
}
