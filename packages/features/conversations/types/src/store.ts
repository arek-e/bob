import type { EffectAdapter } from "@bob/shared-types/effect-adapter"

import { Context, Schema } from "effect"

import type { InboundAcceptance, NormalizedInboundEvent } from "./channel.ts"

export interface ClaimedInbound {
  readonly eventId: string
  readonly ownerId: string
  readonly channelId: string
  readonly messageId: string
  readonly text: string
  readonly providerMessageHandle: string
  readonly service: NormalizedInboundEvent["service"]
  readonly isGroup: boolean
  readonly number: string
  readonly fromNumber: string
  readonly correlationId: string
}

export interface ConversationStoreAdapter {
  acceptInbound(event: NormalizedInboundEvent): Promise<InboundAcceptance>
  markEnqueued(eventId: string, at: string): Promise<void>
  getInboundOwner(eventId: string): Promise<string | undefined>
  claimInbound(eventId: string, leaseMs: number): Promise<ClaimedInbound | undefined>
  claimReaction(eventId: string, at: string): Promise<boolean>
  completeInbound(eventId: string, at: string): Promise<void>
  prepareInboundRecovery(
    eventId: string,
    maxRecoveries: number
  ): Promise<"recover" | "complete" | "exhausted" | "missing">
  pendingBindings(
    ownerId: string,
    command: string,
    now: string
  ): Promise<
    readonly {
      id: string
      command: string
      targetType: string
      targetId: string
      expiresAt: string
    }[]
  >
}

export class ConversationStoreError extends Schema.TaggedError<ConversationStoreError>()(
  "ConversationStoreError",
  { operation: Schema.String, cause: Schema.Unknown }
) {}

export class ConversationStore extends Context.Service<
  ConversationStore,
  EffectAdapter<ConversationStoreAdapter, ConversationStoreError>
>()("@bob/conversations/ConversationStore") {}
