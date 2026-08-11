import { createServer, type IncomingMessage, type ServerResponse } from "node:http"

import { NodeRuntime } from "@effect/platform-node"
import { Effect } from "effect"

import { composeAgent } from "./composition.ts"
import { handleAgentHttp } from "./http.ts"
import { AGENT_LISTEN_HOST } from "./listener.ts"

const MAX_BODY_BYTES = 64 * 1024

async function toRequest(input: IncomingMessage): Promise<Request> {
  const host = input.headers.host ?? "localhost"
  const method = input.method ?? "GET"
  const headers = new Headers()
  for (const [name, value] of Object.entries(input.headers)) {
    if (value === undefined) continue
    headers.set(name, Array.isArray(value) ? value.join(",") : value)
  }
  if (method === "GET" || method === "HEAD") {
    return new Request(`http://${host}${input.url ?? "/"}`, { method, headers })
  }
  const chunks: Uint8Array[] = []
  let size = 0
  for await (const value of input) {
    const chunk =
      typeof value === "string" ? new TextEncoder().encode(value) : new Uint8Array(value)
    size += chunk.byteLength
    if (size > MAX_BODY_BYTES) throw new Error("body_too_large")
    chunks.push(chunk)
  }
  const body = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new Request(`http://${host}${input.url ?? "/"}`, { method, headers, body })
}

async function writeResponse(output: ServerResponse, response: Response): Promise<void> {
  output.statusCode = response.status
  response.headers.forEach((value, name) => output.setHeader(name, value))
  output.end(new Uint8Array(await response.arrayBuffer()))
}

const composition = composeAgent(process.env)
const server = createServer(async (input, output) => {
  try {
    await writeResponse(output, await handleAgentHttp(await toRequest(input), composition))
  } catch (error) {
    const status = error instanceof Error && error.message === "body_too_large" ? 413 : 500
    await writeResponse(
      output,
      Response.json(
        { code: status === 413 ? "body_too_large" : "internal_error" },
        { status, headers: { "cache-control": "no-store" } }
      )
    )
  }
})

const main = Effect.acquireRelease(
  Effect.callback<typeof server>((resume) => {
    const onError = (error: Error) => resume(Effect.die(error))
    server.once("error", onError)
    server.listen(composition.config.port, AGENT_LISTEN_HOST, () => {
      server.off("error", onError)
      resume(Effect.succeed(server))
    })
  }),
  (active) =>
    Effect.callback<void>((resume) => {
      active.close(() => resume(Effect.void))
    })
).pipe(
  Effect.flatMap(() => Effect.never),
  Effect.scoped
)

NodeRuntime.runMain(main)
