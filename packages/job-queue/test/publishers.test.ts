import { describe, expect, it, vi } from "vitest"

import { makeBullMqJobProcessor, makeBullMqJobPublisher } from "../src/bullmq.ts"
import { decodeJobProcessor, completeJob, retryJob } from "../src/index.ts"
import { makeQueueBindingJobPublisher, processQueueBindingMessage } from "../src/queue-binding.ts"

interface ExampleJob {
  readonly id: string
}

describe("JobPublisher Adapters", () => {
  it("publishes immediately through a runtime queue binding", async () => {
    const send = vi.fn(async () => undefined)
    const publisher = makeQueueBindingJobPublisher<ExampleJob, void>({ send })

    await publisher.publish({ id: "one" })

    expect(send).toHaveBeenCalledWith({ id: "one" })
  })

  it("rounds a queue binding delay up so work never starts early", async () => {
    const send = vi.fn(async () => undefined)
    const publisher = makeQueueBindingJobPublisher<ExampleJob, void>({ send })

    await publisher.publish({ id: "one" }, { delayMs: 1_001 })

    expect(send).toHaveBeenCalledWith({ id: "one" }, { delaySeconds: 2 })
  })

  it("preserves millisecond delays through BullMQ", async () => {
    const add = vi.fn(async () => ({ id: "job" }))
    const publisher = makeBullMqJobPublisher<ExampleJob, { id: string }>({ add }, "inbound")

    await publisher.publish({ id: "one" }, { delayMs: 1_001 })

    expect(add).toHaveBeenCalledWith("inbound", { id: "one" }, { delay: 1_001 })
  })

  it("rejects an empty BullMQ job name", () => {
    expect(() => makeBullMqJobPublisher({ add: async () => undefined }, "  ")).toThrow(TypeError)
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
    const process = makeBullMqJobProcessor(
      { process: async () => completeJob },
      { makeDelayedError: () => new Error("delayed") }
    )

    await process({ data: { id: "one" }, moveToDelayed }, "token")

    expect(moveToDelayed).not.toHaveBeenCalled()
  })

  it("moves a BullMQ retry to delayed and signals delayed completion", async () => {
    const moveToDelayed = vi.fn(async () => undefined)
    const delayed = new Error("delayed")
    const process = makeBullMqJobProcessor(
      { process: async () => retryJob(1_001) },
      { makeDelayedError: () => delayed, now: () => 10_000 }
    )

    await expect(process({ data: { id: "one" }, moveToDelayed }, "token")).rejects.toBe(delayed)
    expect(moveToDelayed).toHaveBeenCalledWith(11_001, "token")
  })
})
