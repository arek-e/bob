import { transitionalDeploymentProfile } from "@bob/contracts/deployment-profiles"

import { makeJournalConversationWorkflow } from "../src/modules/journal/conversation-workflow.ts"
import { makeReminderConversationWorkflow } from "../src/modules/reminders/conversation-workflow.ts"
import { makeRuntimeModules } from "../src/modules/runtime/module.ts"
import { makeTrainingConversationWorkflow } from "../src/modules/training/conversation-workflow.ts"

interface CompatibilityServices {
  readonly training?: Parameters<typeof makeTrainingConversationWorkflow>[0]
  readonly journal?: Parameters<typeof makeJournalConversationWorkflow>[0]
  readonly turns?: Parameters<typeof makeJournalConversationWorkflow>[1]
  readonly reminders?: Parameters<typeof makeReminderConversationWorkflow>[1]
  readonly conversations?: Parameters<typeof makeReminderConversationWorkflow>[0]
}

interface CompatibilityComposition {
  readonly services?: CompatibilityServices
  readonly config?: { readonly UI_BASE_URL?: string }
}

export type TestFixture<T> = {
  readonly [Key in keyof T]?: T[Key] extends object ? TestFixture<T[Key]> : T[Key]
}

export function testFixture<T>(value: TestFixture<T>): T {
  // SAFETY: The optional compatibility view reads only focused doubles declared by each test.
  const fixture = value as TestFixture<T> & CompatibilityComposition
  const services = fixture.services
  const config = fixture.config
  const conversations = []
  if (services?.training !== undefined) {
    conversations.push(makeTrainingConversationWorkflow(services.training))
  }
  if (services?.journal !== undefined && services.turns !== undefined) {
    conversations.push(
      makeJournalConversationWorkflow(services.journal, services.turns, config?.UI_BASE_URL ?? "")
    )
  }
  if (services?.reminders !== undefined && services.conversations !== undefined) {
    conversations.push(makeReminderConversationWorkflow(services.conversations, services.reminders))
  }
  // SAFETY: A focused test double implements every member exercised by its test.
  return (
    "services" in (value as object) && !("profile" in (value as object))
      ? {
          profile: transitionalDeploymentProfile,
          runtime: makeRuntimeModules({ conversations }),
          ...value
        }
      : value
  ) as T
}
