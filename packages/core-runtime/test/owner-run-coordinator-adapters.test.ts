import { describe, expect, it, vi } from "vitest"

import {
  makeOwnerWakeJobProcessor,
  makeQueuedOwnerRunCoordinator
} from "../src/runtime/owner-run-coordinator.ts"

const ownerId = "018e6f65-4d55-7a1b-8df4-4ee15ea1db91"
const eventId = "018e6f65-4d55-7a1b-8df4-4ee15ea1db90"

describe("Compose Owner Run Coordinator Adapter", () => {
  it("accepts runs through the local owner engine", async () => {
    const accept = vi.fn(async () => Response.json({ ok: true }, { status: 202 }))
    const coordinator = makeQueuedOwnerRunCoordinator({
      accept,
      wakeJobs: { publish: vi.fn(async () => undefined) }
    })
    const request = { ownerId, correlationId: eventId, job: { eventId } }

    await expect(coordinator.run(request)).resolves.toMatchObject({ status: 202 })
    expect(accept).toHaveBeenCalledWith(request)
  })

  it("publishes immediate and delayed durable wake jobs", async () => {
    const publish = vi.fn(async () => undefined)
    const coordinator = makeQueuedOwnerRunCoordinator({
      accept: async () => Response.json({ ok: true }),
      wakeJobs: { publish },
      now: () => new Date("2026-08-16T10:00:00.000Z")
    })

    await coordinator.wake({ ownerId })
    await coordinator.wake({ ownerId, wakeAt: "2026-08-16T10:00:05.000Z" })

    expect(publish).toHaveBeenNthCalledWith(
      1,
      { ownerId, requestedAt: "2026-08-16T10:00:00.000Z" },
      { delayMs: 0 }
    )
    expect(publish).toHaveBeenNthCalledWith(
      2,
      { ownerId, requestedAt: "2026-08-16T10:00:05.000Z" },
      { delayMs: 5_000 }
    )
  })

  it("completes a wake job only after the owner engine runs", async () => {
    const wake = vi.fn(async () => undefined)
    const processor = makeOwnerWakeJobProcessor({ wake })
    const job = { ownerId, requestedAt: "2026-08-16T10:00:05.000Z" }

    await expect(processor.process(job)).resolves.toEqual({ state: "complete" })
    expect(wake).toHaveBeenCalledWith(job)
  })
})
