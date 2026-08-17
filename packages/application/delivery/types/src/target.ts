import type { DatabaseQuery } from "@bob/db-types"

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
  statements(event: DeliveryTargetEvent): Promise<readonly DatabaseQuery[]>
}

export interface DeliveryTargetRegistry {
  adapterFor(targetType: string): DeliveryTargetAdapter | undefined
}
