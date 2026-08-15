import { once } from "node:events"
import { createServer, request as httpRequest } from "node:http"
import { describe, expect, it } from "vitest"

import { createNodeHttpHandler } from "../src/node-http.ts"

describe("agent Node HTTP bridge", () => {
  it("aborts the web request when the client disconnects", async () => {
    let markStarted!: () => void
    const started = new Promise<void>((resolve) => {
      markStarted = resolve
    })
    let markCancelled!: () => void
    const cancelled = new Promise<void>((resolve) => {
      markCancelled = resolve
    })
    const server = createServer(
      createNodeHttpHandler(async (request) => {
        markStarted()
        if (request.signal.aborted) markCancelled()
        else request.signal.addEventListener("abort", markCancelled, { once: true })
        await cancelled
        return new Response(null, { status: 204 })
      })
    )

    server.listen(0, "127.0.0.1")
    await once(server, "listening")
    const address = server.address()
    if (address === null || !(address instanceof Object)) throw new Error("Server has no port")
    const client = httpRequest({
      host: "127.0.0.1",
      port: address.port,
      method: "POST",
      path: "/v1/run",
      headers: { "content-length": "2", "content-type": "application/json" }
    })
    client.on("error", () => undefined)
    client.end("{}")

    await started
    client.destroy()
    let guardTimer: ReturnType<typeof setTimeout> | undefined
    const outcome = await Promise.race([
      cancelled.then(() => "cancelled" as const),
      new Promise<"guard">((resolve) => {
        guardTimer = setTimeout(() => resolve("guard"), 250)
      })
    ])
    if (guardTimer !== undefined) clearTimeout(guardTimer)

    server.closeAllConnections()
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error === undefined ? resolve() : reject(error)))
    )
    expect(outcome).toBe("cancelled")
  })
})
