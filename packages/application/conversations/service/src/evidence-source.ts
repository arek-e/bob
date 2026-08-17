import type { PrivateTextReader } from "@bob/context-service/private-text"
import type { CoreDatabase } from "@bob/db-types"
import type { EvidenceSourceAdapter } from "@bob/memory-types/evidence"
import type { DataProtection } from "@bob/policy-types/data-protection"

import { agentRuns, messages, toolCalls } from "@bob/db-service/schema/conversations"
import { evidenceDate } from "@bob/memory-service/evidence"
import { and, eq } from "drizzle-orm"
import { Effect } from "effect"

export function makeConversationEvidenceSource(
  database: CoreDatabase,
  text: PrivateTextReader,
  protection: DataProtection
): EvidenceSourceAdapter {
  return {
    id: "conversation_evidence",
    sourceTypes: ["message", "agent_run", "tool_call"],
    async verify(reference) {
      switch (reference.sourceType) {
        case "message": {
          const [record] = await Effect.runPromise(
            database
              .select({
                occurredAt: messages.occurredAt,
                direction: messages.direction,
                ciphertext: messages.textCiphertext,
                iv: messages.textIv
              })
              .from(messages)
              .where(
                and(eq(messages.id, reference.sourceId), eq(messages.userId, reference.ownerId))
              )
              .limit(1)
          )
          if (record === undefined) return undefined
          const contentHash = await protection.contentHash(
            await text.decrypt(reference.ownerId, {
              ciphertext: record.ciphertext,
              iv: record.iv
            })
          )
          return {
            sourceLabel:
              record.direction === "inbound"
                ? `Owner message linked on ${evidenceDate(record.occurredAt)}`
                : `Bob reply linked on ${evidenceDate(record.occurredAt)}`,
            occurredAt: record.occurredAt,
            contentHash,
            originClass: record.direction === "inbound" ? "owner_input" : "assistant_output",
            sensitivity: record.direction === "inbound" ? "normal" : "private",
            confirmationAuthority: record.direction === "inbound" ? "owner_ui" : "never",
            disclosure: record.direction === "inbound" ? "model_and_channel" : "private"
          }
        }
        case "agent_run": {
          const [record] = await Effect.runPromise(
            database
              .select({ createdAt: agentRuns.createdAt, inputHash: agentRuns.inputHash })
              .from(agentRuns)
              .where(
                and(eq(agentRuns.id, reference.sourceId), eq(agentRuns.userId, reference.ownerId))
              )
              .limit(1)
          )
          if (record === undefined) return undefined
          return {
            sourceLabel: `Agent run linked on ${evidenceDate(record.createdAt)}`,
            occurredAt: record.createdAt,
            contentHash: record.inputHash,
            originClass: "background_model",
            sensitivity: "private",
            confirmationAuthority: "never",
            disclosure: "private"
          }
        }
        case "tool_call": {
          const [record] = await Effect.runPromise(
            database
              .select({
                createdAt: toolCalls.createdAt,
                commandHash: toolCalls.commandHash,
                id: toolCalls.id
              })
              .from(toolCalls)
              .innerJoin(agentRuns, eq(agentRuns.id, toolCalls.runId))
              .where(
                and(
                  eq(toolCalls.id, reference.sourceId),
                  eq(agentRuns.userId, reference.ownerId),
                  eq(toolCalls.status, "completed")
                )
              )
              .limit(1)
          )
          if (record === undefined) return undefined
          return {
            sourceLabel: `Tool result linked on ${evidenceDate(record.createdAt)}`,
            occurredAt: record.createdAt,
            contentHash:
              record.commandHash ?? (await protection.contentHash(`tool_call:${record.id}`)),
            originClass: "tool_output",
            sensitivity: "private",
            confirmationAuthority: "never",
            disclosure: "private"
          }
        }
      }
    }
  }
}
