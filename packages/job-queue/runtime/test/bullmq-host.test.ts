import { completeJob, retryJob } from "@bob/job-queue-types"
import { describe, expect, it, vi } from "vitest"

import type { BullMqWorkerFactory, BullMqWorkerLike } from "../src/bullmq-host.ts"

import { startBullMqWorkerHost } from "../src/bullmq-host.ts"

function workerHarness() {
  const workers: Array<{
    queueName: string
    process: (job: never, token?: string) => Promise<void>
    options: { concurrency?: number; prefix?: string }
    ready: ReturnType<typeof vi.fn>
    close: ReturnType<typeof vi.fn>
    running: boolean
  }> = []
  const factory: BullMqWorkerFactory = {
    create(queueName, process, options): BullMqWorkerLike {
      // SAFETY: The harness stores the generic processor and calls it only with a matching fake job.
      const value = {
        queueName,
        process: process as (job: never, token?: string) => Promise<void>,
        options,
        ready: vi.fn(async () => undefined),
        close: vi.fn(async () => undefined),
        running: true
      }
      workers.push(value)
      return {
        waitUntilReady: value.ready,
        close: value.close,
        isRunning: () => value.running
      }
    }
  }
  return { workers, factory }
}

describe("BullMqWorkerHost", () => {
  it("owns worker readiness, health, and shutdown", async () => {
    const harness = workerHarness()
    const host = startBullMqWorkerHost(
      [
        { queueName: "inbound", processor: { process: async () => completeJob }, concurrency: 3 },
        { queueName: "delivery", processor: { process: async () => completeJob } }
      ],
      {
        connection: { host: "redis", port: 6379 },
        prefix: "bob",
        workerFactory: harness.factory
      }
    )

    expect(host.queueNames).toEqual(["inbound", "delivery"])
    expect(harness.workers.map((worker) => worker.options)).toEqual([
      expect.objectContaining({ concurrency: 3, prefix: "bob" }),
      expect.objectContaining({ prefix: "bob" })
    ])
    await host.ready()
    expect(host.healthy()).toBe(true)
    harness.workers[0]!.running = false
    expect(host.healthy()).toBe(false)
    await host.close()
    await host.close()
    expect(harness.workers.every((worker) => worker.close.mock.calls.length === 1)).toBe(true)
    expect(host.healthy()).toBe(false)
  })

  it("uses BullMQ delayed settlement for retry dispositions", async () => {
    const harness = workerHarness()
    startBullMqWorkerHost(
      [{ queueName: "inbound", processor: { process: async () => retryJob(2_000) } }],
      { connection: { host: "redis", port: 6379 }, workerFactory: harness.factory }
    )
    const moveToDelayed = vi.fn(async () => undefined)

    // SAFETY: The fake has the two BullMQ job members used by the Adapter.
    await expect(
      harness.workers[0]!.process({ data: {}, moveToDelayed } as never, "token")
    ).rejects.toThrow()
    expect(moveToDelayed).toHaveBeenCalledOnce()
  })

  it("moves unexpected processor failures to delayed retry", async () => {
    const harness = workerHarness()
    startBullMqWorkerHost(
      [
        {
          queueName: "inbound",
          unexpectedErrorDelayMs: 4_000,
          processor: {
            process: async () => {
              throw new Error("unavailable")
            }
          }
        }
      ],
      { connection: { host: "redis", port: 6379 }, workerFactory: harness.factory }
    )
    const moveToDelayed = vi.fn(async () => undefined)

    // SAFETY: The fake has the two BullMQ job members used by the Adapter.
    await expect(
      harness.workers[0]!.process({ data: {}, moveToDelayed } as never, "token")
    ).rejects.toThrow()
    expect(moveToDelayed).toHaveBeenCalledOnce()
  })

  it("rejects invalid route definitions before it starts workers", () => {
    const harness = workerHarness()

    expect(() =>
      startBullMqWorkerHost(
        [
          { queueName: "same", processor: { process: async () => completeJob } },
          { queueName: "same", processor: { process: async () => completeJob } }
        ],
        { connection: { host: "redis", port: 6379 }, workerFactory: harness.factory }
      )
    ).toThrow("Duplicate BullMQ queue route")
    expect(harness.workers).toHaveLength(0)
  })
})
