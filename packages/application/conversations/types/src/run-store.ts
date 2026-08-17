import type {
  AgentArtifact,
  AgentRunOperation,
  AgentRunRequest,
  AgentRunResult
} from "@bob/agent-types/run"
import type { EffectAdapter } from "@bob/shared-types/effect-adapter"

import { Context, Schema } from "effect"

export interface StoredAgentRun {
  readonly request: AgentRunRequest
  readonly status:
    | "pending"
    | "claimed"
    | "executing"
    | "completed"
    | "failed"
    | "unknown"
    | "superseded"
  readonly outboxId?: string
}

export interface ConversationRunCompletion {
  readonly conversationTurnId: string
  readonly conversationTurnRevision: number
}

export interface ConversationReflectionCompletion extends ConversationRunCompletion {
  readonly settleUntil?: string
}

export type ConversationReflectionTransition =
  | { readonly status: "lost" }
  | {
      readonly status: "released" | "settling"
      readonly revision: number
      readonly wakeAt: string
    }

export type AgentRunRetryTransition =
  | { readonly status: "lost" | "exhausted" }
  | { readonly status: "released"; readonly wakeAt?: string }

export interface AgentRunStoreAdapter {
  create(
    request: AgentRunRequest,
    inboundEventId: string
  ): Promise<{ runId: string; duplicate: boolean }>
  loadForInbound(inboundEventId: string): Promise<StoredAgentRun | undefined>
  loadForTurn(turnId: string, revision: number): Promise<StoredAgentRun | undefined>
  claim(runId: string, leaseMs: number): Promise<string | undefined>
  loadOperations(runId: string, attemptId: string): Promise<readonly AgentRunOperation[]>
  appendOperation(
    operation: AgentRunOperation,
    attemptId: string
  ): Promise<"appended" | "duplicate">
  releaseForRetry(
    result: AgentRunResult,
    attemptId: string,
    maxAttempts: number,
    retryDelayMs: number,
    conversation?: ConversationRunCompletion
  ): Promise<AgentRunRetryTransition>
  completeWithResponse(
    result: AgentRunResult,
    response: {
      readonly channelId: string
      readonly text: string
      readonly reasonCode: string
      readonly replyToMessageHandle?: string
      readonly artifact?: AgentArtifact
    },
    conversation?: ConversationRunCompletion,
    attemptId?: string
  ): Promise<string | undefined>
  completeWithoutResponse(result: AgentRunResult, attemptId: string): Promise<boolean>
  completeForReflection(
    result: AgentRunResult,
    attemptId: string,
    conversation: ConversationReflectionCompletion
  ): Promise<ConversationReflectionTransition>
  channelForRun(runId: string): Promise<string | undefined>
}

export class AgentRunStoreError extends Schema.TaggedError<AgentRunStoreError>()(
  "AgentRunStoreError",
  { operation: Schema.String, cause: Schema.Unknown }
) {}

export class AgentRunStore extends Context.Service<
  AgentRunStore,
  EffectAdapter<AgentRunStoreAdapter, AgentRunStoreError>
>()("@bob/conversations/AgentRunStore") {}
