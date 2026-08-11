import {
  MemoryProposeArguments,
  MemorySearchArguments,
  type ToolResult
} from "@bob/contracts/tools"
import { Schema } from "effect"

import type {
  ToolCommandAdapter,
  ToolCommandAdapterContext
} from "../conversations/tool-adapter.ts"
import type { MemoryStore } from "./store.ts"

export function makeMemoryToolAdapter(memory: MemoryStore): ToolCommandAdapter {
  return {
    async execute({ command, run }: ToolCommandAdapterContext): Promise<ToolResult> {
      switch (command.name) {
        case "memory_search": {
          const args = Schema.decodeUnknownSync(MemorySearchArguments)(command.arguments)
          const matches = await memory.search(command.ownerId, args.query, true)
          return {
            ok: true,
            code: "memory_results",
            message: `${matches.length} sources found.`,
            data: JSON.parse(JSON.stringify({ matches }))
          }
        }
        case "memory_propose": {
          const args = Schema.decodeUnknownSync(MemoryProposeArguments)(command.arguments)
          const result = await memory.propose(
            {
              ownerId: command.ownerId,
              ...args,
              originClass: "owner_input",
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
            data: result
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
