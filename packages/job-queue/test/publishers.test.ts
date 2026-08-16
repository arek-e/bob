import { describe, expect, it, vi } from "vitest"

import { makeBullMqJobProcessor, makeBullMqJobPublisher } from "../src/bullmq.ts"
import { makeCloudflareJobPublisher, processCloudflareMessage } from "../src/cloudflare.ts"
import { decodeJobProcessor, completeJob, retryJob } from "../src/index.ts"

interface ExampleJob {
  readonly id: string
}

describe("JobPublisher Adapters", () => {
  it("publishes immediately through Cloudflare Queues", async () => {
    const send = vi.fn(async () => undefined)
    const publisher = makeCloudflareJobPublisher<ExampleJob, void>({ send })

    await publisher.publish({ id: "one" })

    expect(send).toHaveBeenCalledWith({ id: "one" })
  })

  it("rounds a Cloudflare delay up so work never starts early", async () => {
    const send = vi.fn(async () => undefined)
    const publisher = makeCloudflareJobPublisher<ExampleJob, void>({ send })

    await publisher.publish({ id: "one" }, { delayMs: 1_001 })

    expect(send).toHaveBeenCalledWith({ id: "one" }, { delaySeconds: 2 })
  })

  it("preserves millisecond delays through BullMQ", async () => {
    const add = vi.fn(async () => ({ id: "job" }))
    const publisher = makeBullMqJobPublisher<ExampleJob, { id: string }>({ add }, "inbound")

    await publisher.publish({ id: "one" }, { delayMs: 1_001 })

    expect(add).toHaveBeenCalledWith("inbound", { id: "one" }, { delay: 1_001 })
  })

  it.each([-1, 1.5, Number.POSITIVE_INFINITY])(
    "rejects an invalid delay of %s",
    async (delayMs) => {
      const send = vi.fn(async () => undefined)
      const publisher = makeCloudflareJobPublisher<ExampleJob, void>({ send })

      await expect(publisher.publish({ id: "one" }, { delayMs })).rejects.toThrow(RangeError)
      expect(send).not.toHaveBeenCalled()
    }
  )

  it("rejects an empty BullMQ job name", () => {
    expect(() => makeBullMqJobPublisher({ add: async () => undefined }, "  ")).toThrow(TypeError)
  })
})

describe("JobProcessor Adapters", () => {
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

  it("acknowledges a completed Cloudflare job", async () => {
    const ack = vi.fn()
    const retry = vi.fn()

    const disposition = await processCloudflareMessage(
      { body: { id: "one" }, ack, retry },
      { process: async () => completeJob },
      { unexpectedErrorDelayMs: 30_000 }
    )

    expect(disposition).toEqual(completeJob)
    expect(ack).toHaveBeenCalledOnce()
    expect(retry).not.toHaveBeenCalled()
  })

  it("rounds a Cloudflare retry up so it never starts early", async () => {
    const ack = vi.fn()
    const retry = vi.fn()

    await processCloudflareMessage(
      { body: { id: "one" }, ack, retry },
      { process: async () => retryJob(1_001) },
      { unexpectedErrorDelayMs: 30_000 }
    )

    expect(ack).not.toHaveBeenCalled()
    expect(retry).toHaveBeenCalledWith({ delaySeconds: 2 })
  })

  it("retries an unexpected Cloudflare failure with the reviewed delay", async () => {
    const retry = vi.fn()

    await processCloudflareMessage(
      { body: { id: "one" }, ack: vi.fn(), retry },
      {
        process: async () => {
          throw new Error("unavailable")
        }
      },
      { unexpectedErrorDelayMs: 30_000 }
    )

    expect(retry).toHaveBeenCalledWith({ delaySeconds: 30 })
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
