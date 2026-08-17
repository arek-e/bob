import type { DeliveryTargetAdapter, DeliveryTargetRegistry } from "@bob/delivery-types/target"

export type {
  DeliveryTargetAdapter,
  DeliveryTargetEvent,
  DeliveryTargetOutcome,
  DeliveryTargetRegistry
} from "@bob/delivery-types/target"

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
