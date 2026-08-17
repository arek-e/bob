import type { ConversationTurnStoreAdapter } from "@bob/conversations-types/turn-store"
import type { ToolCommandAdapter, ToolCommandAdapterContext } from "@bob/tools-types/adapter"

import { journalCapability, JournalSearchMetadataArguments } from "@bob/journal-types/capability"
import { fromPromiseToolExecution } from "@bob/tools-service/adapter"
import { capabilityToolNames } from "@bob/tools-types/tools"
import { Schema } from "effect"

import type { JournalStore } from "./store.ts"

import { journalAgentMetadata } from "./rules.ts"

export function makeJournalToolAdapter(
  journal: JournalStore,
  turns: Pick<ConversationTurnStoreAdapter, "excludeFromContext">,
  options: { readonly uiBaseUrl: string }
): ToolCommandAdapter {
  return {
    capabilityId: journalCapability.id,
    names: capabilityToolNames(journalCapability),
    execute({ command, run }: ToolCommandAdapterContext) {
      return fromPromiseToolExecution(journalCapability.id, async () => {
        const turnId = run.conversationTurnId
        const revision = run.conversationTurnRevision
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
      })
    }
  }
}
