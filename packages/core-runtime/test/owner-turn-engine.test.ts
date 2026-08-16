import type {
  ConversationTurnSnapshot,
  ConversationTurnStore
} from "@bob/core-service/conversations/turn-store"

import { describe, expect, it, vi } from "vitest"

import { makeOwnerTurnEngine } from "../src/runtime/owner-turn-engine.ts"
import { testFixture } from "./test-fixture.ts"

const eventId = "018e6f65-4d55-7a1b-8df4-4ee15ea1db90"

describe("OwnerTurnEngine", () => {
  it("offers a run and schedules its quiet deadline", async () => {
    const schedule = vi.fn(async () => undefined)
    const offer = vi.fn(async () => ({
      turnId: "turn",
      revision: 1,
      quietUntil: "2026-08-16T10:00:01.000Z",
      appended: false
    }))
    const engine = makeOwnerTurnEngine({
      turns: testFixture<ConversationTurnStore>({ offer }),
      serialize: (operation) => operation(),
      schedule,
      process: vi.fn(),
      steer: vi.fn()
    })

    await engine.accept({ eventId }, eventId)

    expect(offer).toHaveBeenCalledWith(eventId, undefined)
    expect(schedule).toHaveBeenCalledWith(new Date("2026-08-16T10:00:01.000Z"))
  })

  it("claims and processes ready turns until the queue is empty", async () => {
    const snapshot = testFixture<ConversationTurnSnapshot>({
      claimExpiresAt: "2026-08-16T10:00:30.000Z"
    })
    const claimReady = vi.fn().mockResolvedValueOnce(snapshot).mockResolvedValueOnce(undefined)
    const process = vi.fn(async () => undefined)
    const schedule = vi.fn(async () => undefined)
    const engine = makeOwnerTurnEngine({
      turns: testFixture<ConversationTurnStore>({
        claimReady,
        nextWakeAt: vi.fn(async () => undefined)
      }),
      serialize: (operation) => operation(),
      schedule,
      process,
      steer: vi.fn()
    })

    await engine.wake()

    expect(process).toHaveBeenCalledWith(snapshot)
    expect(claimReady).toHaveBeenCalledTimes(2)
  })
})
