import type { ConversationStore } from "@bob/core-service/conversations/store"
import type { ConversationWorkflowModule } from "@bob/core-types/runtime-module"

import { resolveShortReply } from "@bob/core-service/policy/rules"

import type { ReminderStore } from "./store.ts"

const commandAliases = new Map<string, "done" | "seen">([
  ["done", "done"],
  ["klar", "done"],
  ["klart", "done"],
  ["färdig", "done"],
  ["fardig", "done"],
  ["färdigt", "done"],
  ["fardigt", "done"],
  ["seen", "seen"],
  ["sett", "seen"],
  ["uppfattat", "seen"]
])

export function makeReminderConversationWorkflow(
  conversations: ConversationStore,
  reminders: ReminderStore
): ConversationWorkflowModule {
  return {
    id: "reminder-replies",
    async prepare(input) {
      const normalized = input.text.trim().toLowerCase()
      const command = commandAliases.get(normalized)
      if (command === undefined) return undefined
      const swedish = normalized !== command
      const bindings = await conversations.pendingBindings(
        input.ownerId,
        command,
        input.now.toISOString()
      )
      const resolution = resolveShortReply(command, bindings, input.now)
      return {
        reasonCode: `reply_${command}`,
        async execute() {
          let text: string
          if (resolution.kind === "ambiguous") {
            text = swedish
              ? "Fler än en åtgärd matchar. Öppna Bob och välj rätt post."
              : "More than one action matches. Open Bob to choose the correct item."
          } else if (resolution.kind === "none" || resolution.binding.targetType !== "reminder") {
            text = swedish
              ? `Jag kan inte koppla ${input.text.trim().toUpperCase()} till en aktuell post.`
              : `I cannot match ${command.toUpperCase()} to one current item.`
          } else {
            const applied = await reminders.applyBoundReply(
              input.ownerId,
              resolution.binding.id,
              command
            )
            text =
              applied === "invalid"
                ? swedish
                  ? "Åtgärden är inte längre tillgänglig. Öppna Bob och välj posten."
                  : "That action is no longer available. Open Bob to choose the item."
                : command === "done"
                  ? swedish
                    ? "Påminnelsen är markerad som klar."
                    : "Marked complete."
                  : swedish
                    ? "Påminnelsen är markerad som sedd."
                    : "Marked as seen."
          }
          return { text, reasonCode: `reply_${command}`, feature: "reminders" }
        }
      }
    }
  }
}
