import type { ConversationTurnSnapshot } from "@bob/conversations-service/turn-store"

import { artifactStoreLayer } from "@bob/artifacts-service/store"
import { contextStoreLayer } from "@bob/context-service/store"
import { agentRunStoreLayer } from "@bob/conversations-service/run-store"
import { conversationStoreLayer } from "@bob/conversations-service/store"
import { toolExecutorLayer } from "@bob/conversations-service/tool-executor"
import { conversationTurnStoreLayer } from "@bob/conversations-service/turn-store"
import {
  MessageAttachmentStore,
  type MessageAttachmentStoreShape
} from "@bob/conversations-types/attachment-store"
import { type ToolExecutorShape, ToolExecutorError } from "@bob/conversations-types/tool-executor"
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
  readonly [key: string]: object | undefined
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

function completeAdapter<Adapter extends object>(value: object | undefined): Adapter {
  return new Proxy((value ?? {}) as Adapter, {
    get(target, property, receiver) {
      const member = Reflect.get(target, property, receiver) as unknown
      if (typeof member === "function") {
        return (...arguments_: unknown[]) =>
          Promise.resolve(Reflect.apply(member, target, arguments_) as unknown)
      }
      if (property === "priorToolReceipts") return async () => []
      if (property === "mutationActivity") return async () => ({ status: "none" as const })
      return async () => {
        throw new Error(`Missing test Adapter operation: ${String(property)}`)
      }
    }
  })
}

function completeToolExecutor(value: object | undefined): ToolExecutorShape {
  const member = (operation: keyof ToolExecutorShape) =>
    typeof Reflect.get(value ?? {}, operation) === "function"
      ? (Reflect.get(value ?? {}, operation) as (...arguments_: unknown[]) => unknown)
      : undefined
  const run = <A>(operation: keyof ToolExecutorShape, fallback: A, arguments_: unknown[]) =>
    Effect.suspend(() => {
      const execute = member(operation)
      if (execute === undefined) return Effect.succeed(fallback)
      try {
        const result = execute(...arguments_)
        if (Effect.isEffect(result)) return result as Effect.Effect<A, ToolExecutorError>
        return Effect.tryPromise({
          try: () => Promise.resolve(result as A),
          catch: (cause) => new ToolExecutorError({ operation, cause })
        })
      } catch (cause) {
        return Effect.fail(new ToolExecutorError({ operation, cause }))
      }
    })
  return {
    execute: (input) => run("execute", { ok: true, code: "unused", message: "Unused." }, [input]),
    mutationActivity: (runId) => run("mutationActivity", { status: "none" as const }, [runId]),
    expireMutationRecovery: (runId) => run("expireMutationRecovery", false, [runId])
  }
}

export function testFixture<
  T,
  const Value extends TestFixture<T> & CompatibilityComposition = TestFixture<T> &
    CompatibilityComposition
>(value: Value): T & Value {
  // SAFETY: The optional compatibility view reads only focused doubles declared by each test.
  const fixture = value as TestFixture<T> & CompatibilityComposition
  const services = fixture.services
  const config = fixture.config
  const conversations = []
  const attachmentService = services?.attachments as MessageAttachmentStoreShape | undefined
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
    "services" in (value as object) && !("profile" in (value as object))
      ? {
          profile: transitionalDeploymentProfile,
          modules: makeRuntimeModules({ conversations }),
          layer,
          runtime: {
            runPromise: <A, E, R>(effect: Effect.Effect<A, E, R>) =>
              // SAFETY: The fixture Layer provides every Core Interface used by focused tests.
              Effect.runPromise(effect.pipe(Effect.provide(runtimeLayer)) as Effect.Effect<A, E>),
            dispose: async () => undefined
          },
          ...(value as object)
        }
      : (value as object)
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
