import type { MemoryStoreAdapter } from "@bob/memory-types/store"

import { Effect } from "effect"
import { describe, expect, it, vi } from "vitest"

import { MemoryStore, memoryStoreLayer } from "../src/store.ts"

function makeStore(): MemoryStoreAdapter {
  return {
    async propose(input, idempotencyKey) {
      const candidateId = crypto.randomUUID()
      await this.confirm(input.ownerId, candidateId, "owner_ui", `${idempotencyKey}:confirm`)
      return { candidateId, status: "confirmed" }
    },
    confirm: vi.fn(async (_ownerId, candidateId) => candidateId),
    async correct() {
      return crypto.randomUUID()
    },
    async reject() {},
    async listCandidates() {
      return []
    }
  }
}

describe("memoryStoreLayer", () => {
  it("keeps the Adapter receiver for methods that call another Adapter method", async () => {
    const store = makeStore()
    await Effect.runPromise(
      Effect.gen(function* () {
        const memory = yield* MemoryStore
        yield* memory.propose(
          {
            ownerId: crypto.randomUUID(),
            scope: "owner",
            key: "preference",
            value: "test",
            canonicalText: "Test preference",
            sourceType: "test",
            sourceId: crypto.randomUUID(),
            extractionConfidence: 1,
            importance: 1,
            explicitRemember: true,
            authority: "owner_deterministic"
          },
          "test-proposal"
        )
      }).pipe(Effect.provide(memoryStoreLayer(store)))
    )

    expect(store.confirm).toHaveBeenCalledOnce()
  })
})
