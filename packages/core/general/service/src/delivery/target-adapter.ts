import type { CoreBatchQuery } from "@bob/core-types/database"

export type DeliveryTargetOutcome = "accepted" | "failed" | "cancelled"

export interface DeliveryTargetEvent {
  readonly outcome: DeliveryTargetOutcome
  readonly targetId: string
  readonly ownerId: string
  readonly messageId: string
  readonly occurredAt: string
}

export interface DeliveryTargetAdapter {
  readonly targetType: string
  statements(event: DeliveryTargetEvent): Promise<readonly CoreBatchQuery[]>
}

export interface DeliveryTargetRegistry {
  adapterFor(targetType: string): DeliveryTargetAdapter | undefined
}

export function makeDeliveryTargetRegistry(
  adapters: readonly DeliveryTargetAdapter[] = []
): DeliveryTargetRegistry {
  const byType = new Map<string, DeliveryTargetAdapter>()
  for (const adapter of adapters) {
    if (adapter.targetType.trim().length === 0) throw new Error("Delivery target type is required")
    if (byType.has(adapter.targetType))
      throw new Error(`Duplicate delivery target ${adapter.targetType}`)
    byType.set(adapter.targetType, adapter)
  }
  return Object.freeze({ adapterFor: (targetType: string) => byType.get(targetType) })
}
