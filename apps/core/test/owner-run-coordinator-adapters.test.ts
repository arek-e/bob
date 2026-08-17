import type { OwnerWakeJob } from "@bob/core-types/jobs"
import type { PublishJobOptions } from "@bob/job-queue-types"

import { describe, expect, it, vi } from "vitest"

import {
  makeOwnerWakeJobProcessor,
  makeQueuedOwnerRunCoordinator,
  repairOwnerWakeOutbox
} from "../src/runtime/run-coordinator.ts"

const ownerId = "018e6f65-4d55-7a1b-8df4-4ee15ea1db91"
const eventId = "018e6f65-4d55-7a1b-8df4-4ee15ea1db90"

interface WakeRow {
  readonly id: string
  readonly ownerId: string
  readonly requestedAt: string
  state: "pending" | "published" | "completed"
  readonly createdAt?: string
  publishedAt?: string
  completedAt?: string
}

function wakeOutboxFixture(initial: ReadonlyArray<WakeRow> = []) {
  const rows = initial.map((row) => ({ ...row }))
  const wakeOutbox = {
    async create(input: Omit<WakeRow, "state">) {
      rows.push({ ...input, state: "pending" })
    },
    async markPublished(wakeId: string, publishedAt: string) {
      const row = rows.find((candidate) => candidate.id === wakeId)
      if (row !== undefined && row.state !== "completed")
        Object.assign(row, { state: "published", publishedAt })
    },
    async markCompleted(wakeId: string, completedAt: string) {
      const row = rows.find((candidate) => candidate.id === wakeId)
      if (row !== undefined) Object.assign(row, { state: "completed", completedAt })
    },
    async incomplete() {
      return rows.filter((row) => row.state !== "completed")
    }
  }
  return { wakeOutbox, rows }
}

describe("Compose Owner Run Coordinator Adapter", () => {
  it("accepts runs through the local owner engine", async () => {
    const accept = vi.fn(async () => Response.json({ ok: true }, { status: 202 }))
    const { wakeOutbox } = wakeOutboxFixture()
    const coordinator = makeQueuedOwnerRunCoordinator({
      accept,
      wakeJobs: { publish: vi.fn(async () => undefined) },
      wakeOutbox
    })
    const request = { ownerId, correlationId: eventId, job: { eventId } }

    await expect(coordinator.run(request)).resolves.toMatchObject({ status: 202 })
    expect(accept).toHaveBeenCalledWith(request)
  })

  it("publishes immediate and delayed durable wake jobs", async () => {
    const publish = vi.fn(async (_job: OwnerWakeJob, _options?: PublishJobOptions) => undefined)
    const { wakeOutbox, rows } = wakeOutboxFixture()
    const coordinator = makeQueuedOwnerRunCoordinator({
      accept: async () => Response.json({ ok: true }),
      wakeJobs: { publish },
      wakeOutbox,
      now: () => new Date("2026-08-16T10:00:00.000Z")
    })

    await coordinator.wake({ ownerId })
    await coordinator.wake({ ownerId, wakeAt: "2026-08-16T10:00:05.000Z" })

    const firstWake = publish.mock.calls[0]?.[0]
    const secondWake = publish.mock.calls[1]?.[0]
    expect(firstWake).toMatchObject({ ownerId, requestedAt: "2026-08-16T10:00:00.000Z" })
    expect(secondWake).toMatchObject({ ownerId, requestedAt: "2026-08-16T10:00:05.000Z" })
    expect(publish.mock.calls[0]?.[1]).toEqual({
      delayMs: 0,
      deduplicationKey: firstWake?.wakeId
    })
    expect(publish.mock.calls[1]?.[1]).toEqual({
      delayMs: 5_000,
      deduplicationKey: secondWake?.wakeId
    })
    expect(rows).toHaveLength(2)
    expect(rows.every((row) => row.state === "published")).toBe(true)
  })

  it("completes a wake job only after the owner engine runs", async () => {
    const wake = vi.fn(async () => undefined)
    const complete = vi.fn(async () => undefined)
    const processor = makeOwnerWakeJobProcessor({ wake, complete })
    const job = { wakeId: eventId, ownerId, requestedAt: "2026-08-16T10:00:05.000Z" }

    await expect(processor.process(job)).resolves.toEqual({ state: "complete" })
    expect(wake).toHaveBeenCalledWith(job)
    expect(complete).toHaveBeenCalledWith(eventId)
  })

  it("reconstructs a lost Redis wake from PostgreSQL", async () => {
    const { wakeOutbox, rows } = wakeOutboxFixture([
      {
        id: eventId,
        ownerId,
        requestedAt: "2026-08-16T10:00:05.000Z",
        state: "pending"
      }
    ])
    const publish = vi.fn(async (_job: OwnerWakeJob, _options?: PublishJobOptions) => undefined)

    await repairOwnerWakeOutbox(wakeOutbox, { publish }, new Date("2026-08-16T10:00:10.000Z"))

    expect(publish).toHaveBeenCalledWith(
      { wakeId: eventId, ownerId, requestedAt: "2026-08-16T10:00:05.000Z" },
      { delayMs: 0, deduplicationKey: eventId }
    )
    expect(rows[0]).toMatchObject({ state: "published" })
  })
})
