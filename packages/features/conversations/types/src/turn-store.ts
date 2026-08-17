import type { EffectAdapter } from "@bob/capabilities-types/effect-adapter"

import { Context, Schema } from "effect"

export interface OfferedConversationTurn {
  readonly turnId: string
  readonly revision: number
  readonly status: "collecting" | "running" | "settling" | "committing" | "replied"
  readonly quietUntil: string
  readonly appended: boolean
  readonly activeRunId?: string
}

export interface SettlingConversationTurn {
  readonly claimExpiresAt: string
}

export interface ConversationTurnMessage {
  readonly eventId: string
  readonly messageId: string
  readonly text: string
  readonly ordinal: number
}

export interface ConversationTurnLatest extends ConversationTurnMessage {
  readonly providerMessageHandle: string
  readonly service: "imessage" | "sms" | "rcs" | "unknown"
  readonly isGroup: boolean
  readonly correlationId: string
  readonly number: string
  readonly fromNumber: string
  readonly traceparent?: string
}

export interface ConversationTurnSnapshot {
  readonly turnId: string
  readonly ownerId: string
  readonly channelId: string
  readonly revision: number
  readonly claimExpiresAt: string
  readonly latest: ConversationTurnLatest
  readonly messages: readonly ConversationTurnMessage[]
}

export interface ConversationTurnStoreAdapter {
  offer(inboundEventId: string, traceparent?: string): Promise<OfferedConversationTurn>
  claimReady(turnId?: string, leaseMs?: number): Promise<ConversationTurnSnapshot | undefined>
  nextWakeAt(): Promise<string | undefined>
  currentRevision(turnId: string): Promise<number | undefined>
  excludeFromContext(turnId: string, revision: number): Promise<boolean>
  excludeMessageFromContext(messageId: string): Promise<boolean>
  markRunning(turnId: string, revision: number, runId: string): Promise<boolean>
  markSettling(
    turnId: string,
    latestRevision: number,
    activeRunId: string
  ): Promise<SettlingConversationTurn | undefined>
  releaseSettling(
    turnId: string,
    activeRunId: string
  ): Promise<{ readonly ready: boolean; readonly quietUntil?: string }>
  releaseSettlingForRun(
    activeRunId: string
  ): Promise<{ readonly ownerId: string; readonly quietUntil: string } | undefined>
  commitReply(
    turnId: string,
    revision: number,
    runId: string,
    outboxId: string
  ): Promise<"committed" | "superseded">
  markEventsProcessed(turnId: string, revision: number): Promise<number>
}

export class ConversationTurnStoreError extends Schema.TaggedError<ConversationTurnStoreError>()(
  "ConversationTurnStoreError",
  { operation: Schema.String, cause: Schema.Unknown }
) {}

export class ConversationTurnStore extends Context.Service<
  ConversationTurnStore,
  EffectAdapter<ConversationTurnStoreAdapter, ConversationTurnStoreError>
>()("@bob/conversations/ConversationTurnStore") {}
