import type { EffectAdapter } from "@bob/capabilities-types/effect-adapter"

import { Context, Schema } from "effect"

export interface AlertInput {
  readonly ownerId: string
  readonly code: string
  readonly objectType: string
  readonly objectId: string
  readonly idempotencyKey: string
}

export interface OperationalAlert {
  readonly id: string
  readonly code: string
  readonly objectType: string
  readonly objectId: string
  readonly idempotencyKey: string
  readonly state: string
  readonly createdAt: string
  readonly updatedAt: string
  readonly resolvedAt: string | null
}

export interface AlertStoreAdapter {
  record(input: AlertInput): Promise<string>
  list(ownerId: string): Promise<readonly unknown[]>
  get(ownerId: string, alertId: string): Promise<OperationalAlert | undefined>
  setState(ownerId: string, alertId: string, state: "reconciling" | "resolved"): Promise<void>
}

export class AlertStoreError extends Schema.TaggedError<AlertStoreError>()("AlertStoreError", {
  operation: Schema.String,
  cause: Schema.Unknown
}) {}

export class AlertStore extends Context.Service<
  AlertStore,
  EffectAdapter<AlertStoreAdapter, AlertStoreError>
>()("@bob/operations/AlertStore") {}
