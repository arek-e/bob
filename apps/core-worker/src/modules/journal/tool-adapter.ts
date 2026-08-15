import {
  journalCapability,
  JournalSearchMetadataArguments
} from "@bob/contracts/capabilities/journal"
import { Schema } from "effect"

import type {
  ToolCommandAdapter,
  ToolCommandAdapterContext
} from "../conversations/tool-adapter.ts"
import type { ConversationTurnStore } from "../conversations/turn-store.ts"
import type { JournalStore } from "./store.ts"

import { journalAgentMetadata } from "./rules.ts"

export function makeJournalToolAdapter(
  journal: JournalStore,
  turns: Pick<ConversationTurnStore, "excludeFromContext">,
  options: { readonly uiBaseUrl: string }
): ToolCommandAdapter {
  return {
    capabilityId: journalCapability.id,
    names: journalCapability.names,
    async execute({ command, run }: ToolCommandAdapterContext) {
      const turnId = run.request.conversationTurnId
      const revision = run.request.conversationTurnRevision
      if (
        turnId === undefined ||
        revision === undefined ||
        !(await turns.excludeFromContext(turnId, revision))
      ) {
        return {
          ok: false,
          code: "privacy_policy_failed",
          message: "Bob could not protect this private conversation turn."
        }
      }
      switch (command.name) {
        case "journal_link_create": {
          const handoff = await journal.createHandoff(
            command.ownerId,
            10 * 60_000,
            command.idempotencyKey
          )
          return {
            ok: true,
            code: "journal_link_created",
            message: "Open the private journal link. It expires in 10 minutes.",
            data: {
              path: `${options.uiBaseUrl}/journal/${handoff.id}`,
              expiresAt: handoff.expiresAt,
              bearerToken: false
            }
          }
        }
        case "journal_search_metadata": {
          const args = Schema.decodeUnknownSync(JournalSearchMetadataArguments)(command.arguments)
          const entries = (await journal.searchMetadata(command.ownerId, args.tag)).map(
            journalAgentMetadata
          )
          return {
            ok: true,
            code: "journal_metadata",
            message: `${entries.length} journal entries found.`,
            data: { entries }
          }
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
