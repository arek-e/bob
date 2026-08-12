import type { IncomingMessage, RequestListener, ServerResponse } from "node:http"

const MAX_BODY_BYTES = 64 * 1024

async function toRequest(input: IncomingMessage, signal: AbortSignal): Promise<Request> {
  const host = input.headers.host ?? "localhost"
  const method = input.method ?? "GET"
  const headers = new Headers()
  for (const [name, value] of Object.entries(input.headers)) {
    if (value === undefined) continue
    headers.set(name, Array.isArray(value) ? value.join(",") : value)
  }
  if (method === "GET" || method === "HEAD") {
    return new Request(`http://${host}${input.url ?? "/"}`, { method, headers, signal })
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
  return new Request(`http://${host}${input.url ?? "/"}`, { method, headers, body, signal })
}

async function writeResponse(output: ServerResponse, response: Response): Promise<void> {
  output.statusCode = response.status
  response.headers.forEach((value, name) => output.setHeader(name, value))
  output.end(new Uint8Array(await response.arrayBuffer()))
}

export function createNodeHttpHandler(
  handle: (request: Request) => Promise<Response>
): RequestListener {
  return async (input, output) => {
    const controller = new AbortController()
    const abort = () => {
      if (!controller.signal.aborted) controller.abort("client_disconnected")
    }
    const abortBeforeResponse = () => {
      if (!output.writableEnded) abort()
    }
    input.once("aborted", abort)
    output.once("close", abortBeforeResponse)
    try {
      const response = await handle(await toRequest(input, controller.signal))
      if (!output.destroyed) await writeResponse(output, response)
    } catch (error) {
      if (controller.signal.aborted || output.destroyed) return
      const status = error instanceof Error && error.message === "body_too_large" ? 413 : 500
      await writeResponse(
        output,
        Response.json(
          { code: status === 413 ? "body_too_large" : "internal_error" },
          { status, headers: { "cache-control": "no-store" } }
        )
      )
    } finally {
      input.off("aborted", abort)
      output.off("close", abortBeforeResponse)
    }
  }
}
