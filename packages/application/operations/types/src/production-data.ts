import type { EffectAdapter } from "@bob/shared-types/effect-adapter"

import { Context, Schema } from "effect"

export const PRODUCTION_DATA_DEFAULT_LIMIT = 50
export const PRODUCTION_DATA_MAX_LIMIT = 100
export const PRODUCTION_DATA_DEFAULT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000
export const PRODUCTION_DATA_MAX_WINDOW_MS = 31 * 24 * 60 * 60 * 1000

export interface ProductionDataQuery {
  readonly from: string
  readonly to: string
  readonly limit: number
}

export interface ProductionDataCount {
  readonly key: string
  readonly count: number
}

export interface ProductionDataOwnerSummary {
  readonly ownerRef: string
  readonly messages: number
  readonly inboundMessages: number
  readonly outboundMessages: number
  readonly agentRuns: number
  readonly completedRuns: number
  readonly failedRuns: number
  readonly toolCalls: number
}

export interface ProductionDataSummary {
  readonly from: string
  readonly to: string
  readonly totalMessages: number
  readonly totalOwners: number
  readonly totalAgentRuns: number
  readonly totalToolCalls: number
  readonly messageDirections: readonly ProductionDataCount[]
  readonly inboundEventStates: readonly ProductionDataCount[]
  readonly agentRunStates: readonly ProductionDataCount[]
  readonly deliveryStates: readonly ProductionDataCount[]
  readonly toolCallStates: readonly ProductionDataCount[]
  readonly owners: readonly ProductionDataOwnerSummary[]
}

export interface ProductionDataInboundEvent {
  readonly id: string
  readonly messageId: string
  readonly correlationId: string
  readonly service: string
  readonly isGroup: boolean
  readonly attachmentCount: number
  readonly recoveryCount: number
  readonly enqueuedAt: string | null
  readonly claimedAt: string | null
  readonly processedAt: string | null
  readonly deadLetteredAt: string | null
  readonly createdAt: string
}

export interface ProductionDataAgentRun {
  readonly id: string
  readonly correlationId: string
  readonly originType: string | null
  readonly status: string
  readonly model: string
  readonly executionPoolId: string | null
  readonly claimedAt: string | null
  readonly completedAt: string | null
  readonly finalizationCompletedAt: string | null
  readonly createdAt: string
}

export interface ProductionDataOutboxMessage {
  readonly id: string
  readonly messageId: string
  readonly reasonCode: string
  readonly correlationId: string
  readonly state: string
  readonly enqueuedAt: string | null
  readonly claimedAt: string | null
  readonly deadLetteredAt: string | null
  readonly completedAt: string | null
  readonly createdAt: string
}

export interface ProductionDataDeliveryAttempt {
  readonly id: string
  readonly outboxId: string
  readonly attemptNumber: number
  readonly state: string
  readonly errorCode: string | null
  readonly startedAt: string
  readonly updatedAt: string
}

export interface ProductionDataToolCall {
  readonly id: string
  readonly runId: string
  readonly toolName: string
  readonly status: string
  readonly attemptNumber: number
  readonly claimedAt: string | null
  readonly completedAt: string | null
  readonly createdAt: string
}

export interface ProductionDataWorkflow {
  readonly correlationId: string
  readonly inboundEvents: readonly ProductionDataInboundEvent[]
  readonly agentRuns: readonly ProductionDataAgentRun[]
  readonly outboxMessages: readonly ProductionDataOutboxMessage[]
  readonly deliveryAttempts: readonly ProductionDataDeliveryAttempt[]
  readonly toolCalls: readonly ProductionDataToolCall[]
}

export interface ProductionDataInspectorAdapter {
  summary(input: ProductionDataQuery): Promise<ProductionDataSummary>
  workflow(correlationId: string, limit: number): Promise<ProductionDataWorkflow>
}

export class ProductionDataInspectorError extends Schema.TaggedError<ProductionDataInspectorError>()(
  "ProductionDataInspectorError",
  { operation: Schema.String, cause: Schema.Unknown }
) {}

export class ProductionDataInspector extends Context.Service<
  ProductionDataInspector,
  EffectAdapter<ProductionDataInspectorAdapter, ProductionDataInspectorError>
>()("@bob/operations/ProductionDataInspector") {}

export function parseProductionDataQuery(
  input: {
    readonly from?: string | null
    readonly to?: string | null
    readonly limit?: string | null
  },
  now = new Date()
): ProductionDataQuery {
  const end = parseInstant(input.to, now, "to")
  const start = parseInstant(
    input.from,
    new Date(end.getTime() - PRODUCTION_DATA_DEFAULT_WINDOW_MS),
    "from"
  )
  const limit = parseLimit(input.limit)
  const duration = end.getTime() - start.getTime()
  if (duration <= 0 || duration > PRODUCTION_DATA_MAX_WINDOW_MS) {
    throw new TypeError("Production data window is outside the allowed range")
  }
  return { from: start.toISOString(), to: end.toISOString(), limit }
}

function parseInstant(value: string | null | undefined, fallback: Date, label: string): Date {
  if (value === undefined || value === null || value.trim().length === 0) return fallback
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) throw new TypeError(`Production data ${label} is invalid`)
  return parsed
}

function parseLimit(value: string | null | undefined): number {
  if (value === undefined || value === null || value.length === 0) {
    return PRODUCTION_DATA_DEFAULT_LIMIT
  }
  if (!/^\d+$/u.test(value)) throw new TypeError("Production data limit is invalid")
  const limit = Number(value)
  if (limit < 1 || limit > PRODUCTION_DATA_MAX_LIMIT) {
    throw new TypeError("Production data limit is outside the allowed range")
  }
  return limit
}
