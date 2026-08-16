import { transitionalDeploymentProfile } from "@bob/contracts/deployment-profiles"

import type { ConversationTurnSnapshot } from "../src/modules/conversations/turn-store.ts"

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

interface ConversationTurnFixtureInput {
  readonly eventId: string
  readonly ownerId: string
  readonly channelId: string
  readonly messageId: string
  readonly text: string
  readonly correlationId: string
  readonly turnId?: string
  readonly revision?: number
  readonly traceparent?: string
  readonly providerMessageHandle?: string
  readonly service?: "imessage" | "sms" | "rcs" | "unknown"
  readonly isGroup?: boolean
  readonly number?: string
  readonly fromNumber?: string
}

export function conversationTurnFixture(
  input: ConversationTurnFixtureInput
): ConversationTurnSnapshot {
  const message = {
    eventId: input.eventId,
    messageId: input.messageId,
    text: input.text,
    ordinal: 1
  }
  const latest = {
    ...message,
    providerMessageHandle: input.providerMessageHandle ?? input.messageId,
    service: input.service ?? ("unknown" as const),
    isGroup: input.isGroup ?? false,
    correlationId: input.correlationId,
    number: input.number ?? "+46700000000",
    fromNumber: input.fromNumber ?? "+46711111111"
  }
  return {
    turnId: input.turnId ?? "018e6f65-4d55-7a1b-8df4-4ee15ea1db89",
    ownerId: input.ownerId,
    channelId: input.channelId,
    revision: input.revision ?? 1,
    claimExpiresAt: "2099-01-01T00:00:00.000Z",
    latest:
      input.traceparent === undefined ? latest : { ...latest, traceparent: input.traceparent },
    messages: [message]
  }
}
