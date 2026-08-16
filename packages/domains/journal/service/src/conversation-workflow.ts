import type { ConversationTurnStore } from "@bob/core-service/conversations/turn-store"
import type { ConversationWorkflowModule } from "@bob/core-types/runtime-module"

import type { JournalStore } from "./store.ts"

const commands = new Set(["journal", "dagbok"])

export function makeJournalConversationWorkflow(
  journal: JournalStore,
  turns: ConversationTurnStore,
  uiBaseUrl: string
): ConversationWorkflowModule {
  return {
    id: "journal-handoff",
    async prepare(input) {
      const command = input.text.trim().toLowerCase()
      if (!commands.has(command)) return undefined
      return {
        reasonCode: "handoff",
        async execute() {
          const excluded = await turns.excludeMessageFromContext(input.messageId)
          if (!excluded) throw new Error("Private turn context exclusion failed")
          const handoff = await journal.createHandoff(
            input.ownerId,
            10 * 60_000,
            `${input.actionIdempotencyScope}:handoff`
          )
          return {
            text:
              command === "dagbok"
                ? `Öppna din privata dagbok: ${uiBaseUrl}/journal/${handoff.id}`
                : `Open your private journal: ${uiBaseUrl}/journal/${handoff.id}`,
            reasonCode: "handoff",
            feature: "journal"
          }
        }
      }
    }
  }
}
