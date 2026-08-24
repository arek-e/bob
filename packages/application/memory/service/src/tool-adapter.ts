import type { RetrievalPipelineAdapter } from "@bob/retrieval-types/retrieval"
import type { ToolCommandAdapter, ToolCommandAdapterContext } from "@bob/tools-types/adapter"

import {
  memoryCapability,
  MemoryProposeArguments,
  MemorySearchArguments
} from "@bob/memory-types/capability"
import { fromPromiseToolExecution } from "@bob/tools-service/adapter"
import { capabilityToolNames, type ToolResult } from "@bob/tools-types/tools"
import { Schema } from "effect"

import type { OwnerFactStore } from "./store.ts"

export function createMemoryToolAdapter(
  memory: OwnerFactStore,
  retrieval: RetrievalPipelineAdapter
): ToolCommandAdapter {
  return {
    capabilityId: memoryCapability.id,
    names: capabilityToolNames(memoryCapability),
    execute({ command, run }: ToolCommandAdapterContext) {
      return fromPromiseToolExecution(memoryCapability.id, async (): Promise<ToolResult> => {
        switch (command.name) {
          case "memory_search": {
            const args = Schema.decodeUnknownSync(MemorySearchArguments)(command.arguments)
            let result
            try {
              result = await retrieval.retrieve({
                ownerId: command.ownerId,
                query: args.query,
                channel: true,
                referenceTime: run.localTime,
                timeZone: run.timeZone,
                limit: 12,
                totalCharacterBudget: 6_000,
                itemCharacterBudget: 1_200
              })
            } catch {
              // Retrieval is a read-only best effort. Do not expose storage details.
              return {
                ok: false,
                code: "memory_unavailable",
                message: "I could not check your saved records right now. Please try again."
              }
            }
            const matches =
              result.status === "supported"
                ? result.items.flatMap((unit) =>
                    unit.kind === "candidate"
                      ? [{ ...unit.item, conflict: false }]
                      : unit.items.map((item) => ({
                          ...item,
                          conflictKey: unit.conflictKey,
                          conflict: true
                        }))
                  )
                : []
            return {
              ok: true,
              code: "memory_results",
              message:
                result.status === "supported"
                  ? `${matches.length} sources found.`
                  : "No supported source found.",
              data: JSON.parse(
                JSON.stringify({
                  matches,
                  retrieval: { status: result.status }
                })
              ),
              evidence: {
                sources: matches.map(({ sourceId, sourceLabel, occurredAt }) => {
                  const source = { sourceId, sourceLabel }
                  if (occurredAt !== undefined) Object.assign(source, { occurredAt })
                  return source
                })
              }
            }
          }
          case "memory_propose": {
            const args = Schema.decodeUnknownSync(MemoryProposeArguments)(command.arguments)
            const result = await memory.propose(
              {
                ownerId: command.ownerId,
                scope: args.scope,
                key: args.key,
                value: args.value,
                canonicalText: args.canonicalText,
                extractionConfidence: args.extractionConfidence,
                importance: args.importance,
                explicitRemember: args.explicitRemember,
                sourceType: "message",
                sourceId: run.messageId,
                authority: "agent"
              },
              command.idempotencyKey
            )
            return {
              ok: true,
              code: "memory_proposed",
              message: "The memory change is ready for review.",
              data: result,
              evidence: { actionOutcome: "proposed" }
            }
          }
          case "memory_confirm":
            return {
              ok: false,
              code: "policy_denied",
              message: "Only the owner review flow can confirm a memory."
            }
          case "memory_correct":
            return {
              ok: false,
              code: "use_bound_command",
              message: "Use the bound owner action for this change."
            }
          default:
            return {
              ok: false,
              code: "domain_error",
              message: "Bob could not complete this action safely."
            }
        }
      })
    }
  }
}
