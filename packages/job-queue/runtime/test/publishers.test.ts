import { decodeJobProcessor, completeJob, retryJob } from "@bob/job-queue-types"
import { describe, expect, it, vi } from "vitest"

import { createBullMqJobProcessor, createBullMqJobPublisher } from "../src/bullmq.ts"
import { createQueueBindingJobPublisher, processQueueBindingMessage } from "../src/queue-binding.ts"

interface ExampleJob {
  readonly id: string
}

describe("JobPublisher Adapters", () => {
  it("publishes immediately through a runtime queue binding", async () => {
    const send = vi.fn(async () => undefined)
    const publisher = createQueueBindingJobPublisher<ExampleJob, void>({ send })

    await publisher.publish({ id: "one" })

    expect(send).toHaveBeenCalledWith({ id: "one" })
  })

  it("rounds a queue binding delay up so work never starts early", async () => {
    const send = vi.fn(async () => undefined)
    const publisher = createQueueBindingJobPublisher<ExampleJob, void>({ send })

    await publisher.publish({ id: "one" }, { delayMs: 1_001 })

    expect(send).toHaveBeenCalledWith({ id: "one" }, { delaySeconds: 2 })
  })

  it("preserves millisecond delays through BullMQ", async () => {
    const add = vi.fn(async () => ({ id: "job" }))
    const publisher = createBullMqJobPublisher<ExampleJob, { id: string }>({ add }, "inbound")

    await publisher.publish({ id: "one" }, { delayMs: 1_001 })

    expect(add).toHaveBeenCalledWith("inbound", { id: "one" }, { delay: 1_001 })
  })

  it("maps a stable deduplication key to a BullMQ job ID", async () => {
    const add = vi.fn(async () => ({ id: "job" }))
    const publisher = createBullMqJobPublisher<ExampleJob, { id: string }>({ add }, "agent-run")

    await publisher.publish(
      { id: "one" },
      { deduplicationKey: "agent-run-10000000-0000-4000-8000-000000000001-1" }
    )

    expect(add).toHaveBeenCalledWith(
      "agent-run",
      { id: "one" },
      {
        jobId: "agent-run-10000000-0000-4000-8000-000000000001-1"
      }
    )
  })

  it("rejects unsupported deduplication on a runtime queue binding", async () => {
    const publisher = createQueueBindingJobPublisher<ExampleJob, void>({
      send: async () => undefined
    })

    await expect(publisher.publish({ id: "one" }, { deduplicationKey: "one" })).rejects.toThrow(
      "does not support deduplication"
    )
  })

  it("rejects an empty BullMQ job name", () => {
    expect(() => createBullMqJobPublisher({ add: async () => undefined }, "  ")).toThrow(TypeError)
  })
})

describe("JobProcessor Adapters", () => {
  it("maps a queue binding retry to whole seconds", async () => {
    const retry = vi.fn()

    await processQueueBindingMessage(
      { body: { id: "one" }, ack: vi.fn(), retry },
      { process: async () => retryJob(1_001) },
      { unexpectedErrorDelayMs: 30_000 }
    )

    expect(retry).toHaveBeenCalledWith({ delaySeconds: 2 })
  })

  it("decodes jobs before dispatch", async () => {
    const decode = vi
      .fn()
      .mockReturnValueOnce("READY")
      .mockImplementationOnce(() => {
        throw new TypeError("invalid")
      })
    const processor = decodeJobProcessor(
      { decode },
      { process: async (input) => (input === "READY" ? completeJob : retryJob(10)) },
      retryJob(50)
    )

    await expect(processor.process("ready")).resolves.toEqual(completeJob)
    await expect(processor.process(42)).resolves.toEqual(retryJob(50))
  })

  it("completes a BullMQ job without moving it", async () => {
    const moveToDelayed = vi.fn(async () => undefined)
    const process = createBullMqJobProcessor(
      { process: async () => completeJob },
      { createDelayedError: () => new Error("delayed") }
    )

    await process({ data: { id: "one" }, moveToDelayed }, "token")

    expect(moveToDelayed).not.toHaveBeenCalled()
  })

  it("moves a BullMQ retry to delayed and signals delayed completion", async () => {
    const moveToDelayed = vi.fn(async () => undefined)
    const delayed = new Error("delayed")
    const process = createBullMqJobProcessor(
      { process: async () => retryJob(1_001) },
      { createDelayedError: () => delayed, now: () => 10_000 }
    )

    await expect(process({ data: { id: "one" }, moveToDelayed }, "token")).rejects.toBe(delayed)
    expect(moveToDelayed).toHaveBeenCalledWith(11_001, "token")
  })
})
