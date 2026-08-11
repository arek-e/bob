import {
  DeliveryReconciliationResult,
  type DeliveryReconciliationResult as DeliveryReconciliationResultValue
} from "@bob/contracts/delivery"
import { Schema } from "effect"

export interface DeliveryReconciler {
  readProviderStatus(messageHandle: string): Promise<DeliveryReconciliationResultValue>
}

export interface DeliveryReconcilerOptions {
  readonly url: string
  readonly callerSecret: string
  readonly fetch?: typeof fetch
  readonly timeoutMs?: number
}

export function makeDeliveryReconciler(options: DeliveryReconcilerOptions): DeliveryReconciler {
  const request = options.fetch ?? fetch
  const timeoutMs = options.timeoutMs ?? 20_000
  const baseUrl = new URL(options.url)
  if (baseUrl.protocol !== "https:" && baseUrl.hostname !== "localhost") {
    throw new Error("Sendblue egress URL must use HTTPS")
  }

  return {
    async readProviderStatus(messageHandle) {
      const controller = new AbortController()
      const timeout = setTimeout(
        () => controller.abort("delivery_reconciliation_timeout"),
        timeoutMs
      )
      try {
        const response = await request(new URL("/internal/reconcile", baseUrl), {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-bob-caller-token": options.callerSecret
          },
          body: JSON.stringify({ messageHandle }),
          signal: controller.signal
        })
        if (!response.ok) {
          throw new Error(`Delivery reconciliation failed with status ${response.status}`)
        }
        return Schema.decodeUnknownSync(DeliveryReconciliationResult)(await response.json())
      } finally {
        clearTimeout(timeout)
      }
    }
  }
}
