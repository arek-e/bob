import { createServer } from "node:http"

const server = createServer(async (request, response) => {
  if (request.method === "GET" && request.url === "/health") {
    response.writeHead(200, { "content-type": "application/json" }).end('{"healthy":true}')
    return
  }
  const chunks = []
  for await (const chunk of request) chunks.push(chunk)
  const input = chunks.length === 0 ? {} : JSON.parse(Buffer.concat(chunks).toString("utf8"))
  response.setHeader("content-type", "application/json")
  if (request.method === "POST" && request.url === "/v1/steer") {
    response.end('{"status":"missing"}')
    return
  }
  if (request.method === "POST" && request.url === "/v1/run") {
    response.end(
      JSON.stringify({
        protocolVersion: 1,
        runId: input.runId,
        correlationId: input.correlationId,
        status: "completed",
        responseText: "Compose runtime is working.",
        sourceIds: [],
        conflict: "none",
        model: "compose-smoke",
        durationMs: 1,
        inputTokens: 1,
        outputTokens: 4,
        toolCalls: 0
      })
    )
    return
  }
  response.writeHead(404).end()
})

server.listen(8787, "0.0.0.0")
