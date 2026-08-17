import type { ConversationTurnSnapshot } from "@bob/conversations-service/turn-store"
import type { ToolCommand, ToolResult } from "@bob/tools-types/tools"

import { artifactStoreLayer } from "@bob/artifacts-service/store"
import { contextStoreLayer } from "@bob/context-service/store"
import { agentRunStoreLayer } from "@bob/conversations-service/run-store"
import { conversationStoreLayer } from "@bob/conversations-service/store"
import { toolExecutorLayer } from "@bob/conversations-service/tool-executor"
import { conversationTurnStoreLayer } from "@bob/conversations-service/turn-store"
import {
  MessageAttachmentStore,
  type MessageAttachmentStoreService
} from "@bob/conversations-types/attachment-store"
import {
  type MutationActivity,
  type ToolExecutorService,
  ToolExecutorError
} from "@bob/conversations-types/tool-executor"
import { makeRuntimeModules } from "@bob/core-types/runtime-module"
import { deliveryStoreLayer } from "@bob/delivery-service/store"
import { transitionalDeploymentProfile } from "@bob/deployment-profile-types/profiles"
import { makeJournalConversationWorkflow } from "@bob/journal-service/conversation-workflow"
import { noopTelemetryLayer } from "@bob/observability"
import { alertStoreLayer } from "@bob/operations-service/alerts/store"
import { makeReminderConversationWorkflow } from "@bob/reminders-service/conversation-workflow"
import { ownerSettingsStoreLayer } from "@bob/settings-service/store"
import { makeTrainingConversationWorkflow } from "@bob/training-service/conversation-workflow"
import { Effect, Layer } from "effect"

export type TestFixture<T> = {
  readonly [Key in keyof T]?: T[Key] extends object ? TestFixture<T[Key]> : T[Key]
}

interface CompatibilityServices {
  readonly alerts?: TestFixture<Parameters<typeof alertStoreLayer>[0]>
  readonly artifacts?: TestFixture<Parameters<typeof artifactStoreLayer>[0]>
  readonly attachments?: Partial<MessageAttachmentStoreService>
  readonly context?: TestFixture<Parameters<typeof contextStoreLayer>[0]>
  readonly delivery?: TestFixture<Parameters<typeof deliveryStoreLayer>[0]>
  readonly events?: object
  readonly runs?: TestFixture<Parameters<typeof agentRunStoreLayer>[0]>
  readonly settings?: TestFixture<Parameters<typeof ownerSettingsStoreLayer>[0]>
  readonly tools?: ToolExecutorFixture
  readonly training?: TestFixture<Parameters<typeof makeTrainingConversationWorkflow>[0]>
  readonly journal?: TestFixture<Parameters<typeof makeJournalConversationWorkflow>[0]>
  readonly turns?: TestFixture<Parameters<typeof conversationTurnStoreLayer>[0]>
  readonly reminders?: TestFixture<Parameters<typeof makeReminderConversationWorkflow>[1]>
  readonly conversations?: TestFixture<Parameters<typeof conversationStoreLayer>[0]>
}

type FixtureResult<Value> = Value | Promise<Value>

interface ToolExecutorFixture {
  readonly execute?: (input: ToolCommand) => FixtureResult<ToolResult>
  readonly mutationActivity?: (runId: string) => FixtureResult<MutationActivity>
  readonly expireMutationRecovery?: (runId: string) => FixtureResult<boolean>
}

interface CompatibilityComposition {
  readonly services?: CompatibilityServices
  readonly config?: { readonly UI_BASE_URL?: string }
}

function completeAdapter<Adapter extends object>(value: TestFixture<Adapter> | undefined): Adapter {
  const target = value ?? {}
  const completed = new Proxy(target, {
    get(current, property) {
      const member = Object.getOwnPropertyDescriptor(current, property)?.value
      if (member instanceof Function) {
        return (...arguments_: never[]) => Promise.resolve(member.call(current, ...arguments_))
      }
      if (property === "priorToolReceipts") return async () => []
      if (property === "mutationActivity") return async () => ({ status: "none" as const })
      return async () => {
        throw new Error(`Missing test Adapter operation: ${String(property)}`)
      }
    }
  })
  // SAFETY: The Proxy supplies a failing async operation for each omitted Adapter method.
  return completed as Adapter
}

function fixtureOperation<Value>(
  operation: keyof ToolExecutorService,
  execute: (() => FixtureResult<Value>) | undefined,
  fallback: Value
) {
  if (execute === undefined) return Effect.succeed(fallback)
  return Effect.tryPromise({
    try: () => Promise.resolve(execute()),
    catch: (cause) => new ToolExecutorError({ operation, cause })
  })
}

function completeToolExecutor(value: ToolExecutorFixture | undefined): ToolExecutorService {
  return {
    execute: (input) =>
      fixtureOperation(
        "execute",
        value?.execute === undefined ? undefined : () => value.execute?.(input) ?? neverFixture(),
        { ok: true, code: "unused", message: "Unused." }
      ),
    mutationActivity: (runId) =>
      fixtureOperation(
        "mutationActivity",
        value?.mutationActivity === undefined
          ? undefined
          : () => value.mutationActivity?.(runId) ?? neverFixture(),
        { status: "none" }
      ),
    expireMutationRecovery: (runId) =>
      fixtureOperation(
        "expireMutationRecovery",
        value?.expireMutationRecovery === undefined
          ? undefined
          : () => value.expireMutationRecovery?.(runId) ?? neverFixture(),
        false
      )
  }
}

function neverFixture(): never {
  throw new Error("The checked fixture operation is missing")
}

export function testFixture<
  T,
  const Value extends TestFixture<T> & CompatibilityComposition = TestFixture<T> &
    CompatibilityComposition
>(value: Value): T & Value {
  const fixture = value
  const services = fixture.services
  const config = fixture.config
  const conversations = []
  const attachmentService = services?.attachments
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
  const layer = Layer.mergeAll(
    artifactStoreLayer(completeAdapter(services?.artifacts)),
    contextStoreLayer(completeAdapter(services?.context)),
    agentRunStoreLayer(completeAdapter(services?.runs)),
    conversationStoreLayer(completeAdapter(services?.conversations)),
    Layer.succeed(
      MessageAttachmentStore,
      MessageAttachmentStore.of({
        storeInbound:
          attachmentService?.storeInbound ?? (() => Effect.die("Missing attachment store")),
        loadForAgent:
          attachmentService?.loadForAgent ?? (() => Effect.die("Missing attachment store"))
      })
    ),
    toolExecutorLayer(completeToolExecutor(services?.tools)),
    conversationTurnStoreLayer(completeAdapter(services?.turns)),
    deliveryStoreLayer(completeAdapter(services?.delivery)),
    alertStoreLayer(completeAdapter(services?.alerts)),
    ownerSettingsStoreLayer(completeAdapter(services?.settings))
  )
  const runtimeLayer = Layer.merge(layer, noopTelemetryLayer)
  const result =
    "services" in value && !("profile" in value)
      ? {
          profile: transitionalDeploymentProfile,
          modules: makeRuntimeModules({ conversations }),
          layer,
          runtime: {
            runPromise: <A, E, R>(effect: Effect.Effect<A, E, R>) => {
              const provided = effect.pipe(Effect.provide(runtimeLayer))
              // SAFETY: The fixture Layer provides every Core Interface used by focused tests.
              return Effect.runPromise(provided as Effect.Effect<A, E>)
            },
            dispose: async () => undefined
          },
          ...value
        }
      : value
  // SAFETY: The fixture adds every Core composition member required by focused tests.
  return result as T & Value
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
