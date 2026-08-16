import type { CoreDatabase } from "@bob/core-types/database"

import { agentRuns, messages, toolCalls } from "@bob/db-service/schema/conversations"
import { and, eq } from "drizzle-orm"

import type { PrivateTextReader } from "../context/private-text.ts"
import type { EvidenceSourceAdapter } from "../memory/evidence.ts"
import type { DataProtection } from "../policy/data-protection.ts"

import { evidenceDate } from "../memory/evidence.ts"

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
          const [record] = await database
            .select({
              occurredAt: messages.occurredAt,
              direction: messages.direction,
              ciphertext: messages.textCiphertext,
              iv: messages.textIv
            })
            .from(messages)
            .where(and(eq(messages.id, reference.sourceId), eq(messages.userId, reference.ownerId)))
            .limit(1)
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
          const [record] = await database
            .select({ createdAt: agentRuns.createdAt, inputHash: agentRuns.inputHash })
            .from(agentRuns)
            .where(
              and(eq(agentRuns.id, reference.sourceId), eq(agentRuns.userId, reference.ownerId))
            )
            .limit(1)
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
          const [record] = await database
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
