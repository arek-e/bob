import { Effect, Fiber } from "effect"
import { once } from "node:events"
import { createServer } from "node:http"
import { describe, expect, it, vi } from "vitest"

import { serveAgent } from "../src/server.ts"

describe("agent server lifecycle", () => {
  it("closes the server and disposes its runtime on shutdown", async () => {
    const server = createServer()
    const disposeRuntime = vi.fn()
    const fiber = Effect.runFork(
      serveAgent(server, {
        host: "127.0.0.1",
        port: 0,
        disposeRuntime: Effect.sync(disposeRuntime)
      })
    )

    await once(server, "listening")
    expect(server.listening).toBe(true)

    await Effect.runPromise(Fiber.interrupt(fiber))

    expect(server.listening).toBe(false)
    expect(disposeRuntime).toHaveBeenCalledTimes(1)
  })
})
