import { transitionalDeploymentProfile } from "@bob/contracts/deployment-profiles"

import { makeJournalConversationWorkflow } from "../src/modules/journal/conversation-workflow.ts"
import { makeReminderConversationWorkflow } from "../src/modules/reminders/conversation-workflow.ts"
import { makeRuntimeModules } from "../src/modules/runtime/module.ts"
import { makeTrainingConversationWorkflow } from "../src/modules/training/conversation-workflow.ts"

export type TestFixture<T> = {
  readonly [Key in keyof T]?: T[Key] extends object ? TestFixture<T[Key]> : T[Key]
}

interface CompatibilityServices {
  readonly training?: TestFixture<Parameters<typeof makeTrainingConversationWorkflow>[0]>
  readonly journal?: TestFixture<Parameters<typeof makeJournalConversationWorkflow>[0]>
  readonly turns?: TestFixture<Parameters<typeof makeJournalConversationWorkflow>[1]>
  readonly reminders?: TestFixture<Parameters<typeof makeReminderConversationWorkflow>[1]>
  readonly conversations?: TestFixture<Parameters<typeof makeReminderConversationWorkflow>[0]>
}

interface CompatibilityComposition {
  readonly services?: CompatibilityServices
  readonly config?: { readonly UI_BASE_URL?: string }
}

export function testFixture<T>(value: TestFixture<T> & CompatibilityComposition): T {
  // SAFETY: The optional compatibility view reads only focused doubles declared by each test.
  const fixture = value as TestFixture<T> & CompatibilityComposition
  const services = fixture.services
  const config = fixture.config
  const conversations = []
  if (services?.training !== undefined) {
    // SAFETY: The focused double implements the workflow methods exercised by its test.
    const training = services.training as Parameters<typeof makeTrainingConversationWorkflow>[0]
    conversations.push(makeTrainingConversationWorkflow(training))
  }
  if (services?.journal !== undefined && services.turns !== undefined) {
    // SAFETY: The focused doubles implement the workflow methods exercised by their test.
    const journal = services.journal as Parameters<typeof makeJournalConversationWorkflow>[0]
    // SAFETY: The focused doubles implement the workflow methods exercised by their test.
    const turns = services.turns as Parameters<typeof makeJournalConversationWorkflow>[1]
    conversations.push(makeJournalConversationWorkflow(journal, turns, config?.UI_BASE_URL ?? ""))
  }
  if (services?.reminders !== undefined && services.conversations !== undefined) {
    // SAFETY: The focused doubles implement the workflow methods exercised by their test.
    const source = services.conversations as Parameters<typeof makeReminderConversationWorkflow>[0]
    // SAFETY: The focused doubles implement the workflow methods exercised by their test.
    const reminders = services.reminders as Parameters<typeof makeReminderConversationWorkflow>[1]
    conversations.push(makeReminderConversationWorkflow(source, reminders))
  }
  // SAFETY: A focused test double implements every member exercised by its test.
  return (
    "services" in (value as object) && !("profile" in (value as object))
      ? {
          profile: transitionalDeploymentProfile,
          runtime: makeRuntimeModules({ conversations }),
          ...(value as object)
        }
      : (value as object)
  ) as T
}
