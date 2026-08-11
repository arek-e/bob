import { AgentRunRequest, AgentRunResult, DeviceLoginEvent } from "@bob/contracts/agent"
import { Schema } from "effect"

import type { AgentComposition } from "./composition.ts"

const MAX_BODY_BYTES = 64 * 1024
const securityHeaders = {
  "cache-control": "no-store",
  "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff"
}

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: securityHeaders })
}

async function readJson(request: Request): Promise<unknown> {
  const declaredLength = Number(request.headers.get("content-length") ?? "0")
  if (declaredLength > MAX_BODY_BYTES) throw new Error("body_too_large")
  if (request.body === null) throw new Error("invalid_body")
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      size += next.value.byteLength
      if (size > MAX_BODY_BYTES) {
        await reader.cancel()
        throw new Error("body_too_large")
      }
      chunks.push(next.value)
    }
  } finally {
    reader.releaseLock()
  }
  const body = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }
  return JSON.parse(new TextDecoder().decode(body)) as unknown
}

export async function handleAgentHttp(
  request: Request,
  composition: AgentComposition
): Promise<Response> {
  const url = new URL(request.url)
  if (request.method === "GET" && url.pathname === "/health") {
    return json({ healthy: true, service: "agent", version: 1 })
  }

  try {
    await composition.services.access.verify(
      request,
      url.pathname.startsWith("/v1/admin/") ? "admin" : "run"
    )
  } catch {
    return json({ code: "unauthorized" }, 401)
  }

  try {
    if (request.method === "POST" && url.pathname === "/v1/run") {
      const input = Schema.decodeUnknownSync(AgentRunRequest)(await readJson(request))
      const output = Schema.decodeUnknownSync(AgentRunResult)(
        await composition.services.agent.runTurn(input)
      )
      await composition.services.events.emit({
        type: "agent_run",
        correlationId: output.correlationId,
        runId: output.runId,
        status: output.status,
        model: output.model,
        durationMs: output.durationMs,
        inputTokens: output.inputTokens,
        outputTokens: output.outputTokens
      })
      return json(output)
    }
    if (request.method === "GET" && url.pathname === "/v1/admin/auth/status") {
      return json(await composition.services.agent.getAuthStatus())
    }
    if (request.method === "POST" && url.pathname === "/v1/admin/auth/device-login") {
      const event = Schema.decodeUnknownSync(DeviceLoginEvent)(
        await composition.services.agent.startDeviceLogin()
      )
      return json(event, event.type === "failed" ? 409 : 202)
    }
    return json({ code: "not_found" }, 404)
  } catch (error) {
    const tooLarge = error instanceof Error && error.message === "body_too_large"
    return json({ code: tooLarge ? "body_too_large" : "invalid_request" }, tooLarge ? 413 : 400)
  }
}
