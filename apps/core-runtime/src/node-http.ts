import type { IncomingMessage, ServerResponse } from "node:http"

export async function webRequest(request: IncomingMessage): Promise<Request> {
  const host = request.headers.host ?? "127.0.0.1"
  const url = new URL(request.url ?? "/", `http://${host}`)
  const method = request.method ?? "GET"
  const headers = new Headers()
  for (const [name, value] of Object.entries(request.headers)) {
    if (value === undefined) continue
    headers.set(name, Array.isArray(value) ? value.join(",") : value)
  }
  if (method === "GET" || method === "HEAD") {
    return new Request(url, { method, headers })
  }
  const chunks: Uint8Array[] = []
  for await (const chunk of request) {
    chunks.push(
      chunk.constructor === Buffer ? new Uint8Array(chunk) : new TextEncoder().encode(chunk)
    )
  }
  const length = chunks.reduce((total, chunk) => total + chunk.byteLength, 0)
  const body = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new Request(url, { method, headers, body })
}

export async function writeWebResponse(response: Response, target: ServerResponse): Promise<void> {
  target.statusCode = response.status
  response.headers.forEach((value, name) => target.setHeader(name, value))
  target.end(new Uint8Array(await response.arrayBuffer()))
}
