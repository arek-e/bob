import {
  memoryCapability,
  MemoryProposeArguments,
  MemorySearchArguments
} from "@bob/contracts/capabilities/memory"
import { type ToolResult } from "@bob/contracts/tools"
import { Schema } from "effect"

import type {
  ToolCommandAdapter,
  ToolCommandAdapterContext
} from "../conversations/tool-adapter.ts"
import type { MemoryRecall, OwnerFactStore } from "./store.ts"

export function makeMemoryToolAdapter(memory: OwnerFactStore & MemoryRecall): ToolCommandAdapter {
  return {
    capabilityId: memoryCapability.id,
    names: memoryCapability.names,
    async execute({ command, run }: ToolCommandAdapterContext): Promise<ToolResult> {
      switch (command.name) {
        case "memory_search": {
          const args = Schema.decodeUnknownSync(MemorySearchArguments)(command.arguments)
          const matches = await memory.search(command.ownerId, args.query, true)
          return {
            ok: true,
            code: "memory_results",
            message: `${matches.length} sources found.`,
            data: JSON.parse(JSON.stringify({ matches })),
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
    }
  }
}
