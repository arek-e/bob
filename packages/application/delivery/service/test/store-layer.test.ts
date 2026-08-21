import type { DeliveryStoreAdapter } from "@bob/delivery-types/store"

import { Effect } from "effect"
import { describe, expect, it, vi } from "vitest"

import { DeliveryStore, deliveryStoreLayer } from "../src/store.ts"

function makeStore(): DeliveryStoreAdapter {
  return {
    async createOutbox() {
      return crypto.randomUUID()
    },
    async markEnqueued() {},
    async claimOutbox() {
      await this.reconcileExpiredClaims(new Date().toISOString())
      return undefined
    },
    async attemptTiming() {
      return undefined
    },
    async recordResult() {
      return []
    },
    async recordProviderEvent() {
      return this.recordResult({
        outboxId: crypto.randomUUID(),
        attemptId: crypto.randomUUID(),
        state: "failed",
        errorCode: "test",
        occurredAt: new Date().toISOString()
      })
    },
    reconcileExpiredClaims: vi.fn(async () => 0),
    async reconcileOutbox() {
      return "missing"
    },
    async reconciliationTarget() {
      return undefined
    },
    async prepareOutboundRecovery() {
      return { status: "missing" }
    },
    async outboxDisposition() {
      return "missing"
    }
  }
}

describe("deliveryStoreLayer", () => {
  it("keeps the Adapter receiver for methods that call another Adapter method", async () => {
    const store = makeStore()
    await Effect.runPromise(
      Effect.gen(function* () {
        const delivery = yield* DeliveryStore
        yield* delivery.claimOutbox(crypto.randomUUID(), 60_000)
      }).pipe(Effect.provide(deliveryStoreLayer(store)))
    )

    expect(store.reconcileExpiredClaims).toHaveBeenCalledOnce()
  })
})
