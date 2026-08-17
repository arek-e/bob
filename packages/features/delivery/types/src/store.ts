import type { NormalizedStatusEvent } from "@bob/conversations-types/channel"
import type { EffectAdapter } from "@bob/shared-types/effect-adapter"

import { Context, Schema } from "effect"

import type { DeliveryResult, OutboxClaim } from "./delivery.ts"

export interface CreateOutboxInput {
  readonly ownerId: string
  readonly channelId: string
  readonly text: string
  readonly reasonCode: string
  readonly correlationId: string
  readonly idempotencyKey: string
  readonly actionTargetType?: string
  readonly actionTargetId?: string
  readonly replyToMessageHandle?: string
  readonly conversationTurnId?: string
  readonly conversationTurnRevision?: number
  readonly dependsOnOutboxId?: string
  readonly artifactId?: string
  readonly artifactRevision?: number
}

interface DeliveryReconciliationIdentity {
  readonly outboxId: string
  readonly attemptId: string
  readonly correlationId: string
}

export type DeliveryReconciliationTarget = DeliveryReconciliationIdentity &
  (
    | { readonly providerMessageHandle: string }
    | {
        readonly destinationE164: string
        readonly payloadFingerprint: string
        readonly since: string
        readonly until: string
      }
  )

export interface DeliveryStoreAdapter {
  createOutbox(input: CreateOutboxInput): Promise<string>
  markEnqueued(outboxId: string, at: string, dispatchGeneration?: number): Promise<void>
  claimOutbox(
    outboxId: string,
    leaseMs: number,
    dispatchGeneration?: number
  ): Promise<OutboxClaim | undefined>
  recordResult(result: DeliveryResult): Promise<readonly string[]>
  recordProviderEvent(event: NormalizedStatusEvent): Promise<readonly string[]>
  reconcileExpiredClaims(at: string): Promise<number>
  reconcileOutbox(outboxId: string): Promise<"resolved" | "pending" | "missing">
  reconciliationTarget(outboxId: string): Promise<DeliveryReconciliationTarget | undefined>
  prepareOutboundRecovery(
    outboxId: string,
    maxRecoveries: number,
    exhaustedGeneration?: number
  ): Promise<
    | { readonly status: "recover"; readonly dispatchGeneration: number }
    | { readonly status: "active" | "limit" | "resolved" | "unsafe" | "missing" }
  >
  outboxDisposition(
    outboxId: string,
    dispatchGeneration?: number
  ): Promise<"active" | "complete" | "missing">
}

export class DeliveryStoreError extends Schema.TaggedError<DeliveryStoreError>()(
  "DeliveryStoreError",
  { operation: Schema.String, cause: Schema.Unknown }
) {}

export class DeliveryStore extends Context.Service<
  DeliveryStore,
  EffectAdapter<DeliveryStoreAdapter, DeliveryStoreError>
>()("@bob/delivery/DeliveryStore") {}
