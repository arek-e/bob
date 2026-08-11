import { AgentRunRequest, AgentRunResult, DeviceLoginEvent } from "@bob/contracts/agent"
import { agentRunSpanCode, featureForTools } from "@bob/observability/attribution"
import { observeNodeSpan, runWithNodeTelemetryContext } from "@bob/observability/node"
import {
  formatTraceparent,
  parseTraceparent,
  traceContextFromCorrelationId,
  type TraceContext
} from "@bob/observability/trace"
import { Schema } from "effect"

import type { AgentComposition } from "./composition.ts"

const MAX_BODY_BYTES = 64 * 1024
const securityHeaders = {
  "cache-control": "no-store",
  "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff"
}

function json(
  value: unknown,
  status = 200,
  extraHeaders: Readonly<Record<string, string>> = {}
): Response {
  return Response.json(value, { status, headers: { ...securityHeaders, ...extraHeaders } })
}

async function emitSafely(
  composition: AgentComposition,
  event: Parameters<AgentComposition["services"]["events"]["emit"]>[0]
) {
  try {
    await composition.services.events.emit(event)
  } catch {
    // Telemetry must not change an agent result.
  }
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
      const feature = featureForTools(input.allowedTools)
      const parent =
        parseTraceparent(request.headers.get("traceparent")) ??
        traceContextFromCorrelationId(input.correlationId)
      let responseTrace: TraceContext | undefined
      const output = await runWithNodeTelemetryContext(
        {
          correlationId: input.correlationId,
          trace: parent,
          feature,
          workflow: "agent_turn"
        },
        () =>
          observeNodeSpan<AgentRunResult>(
            {
              sink: composition.services.events,
              name: "model.run",
              failureCode: "provider",
              resultCode: (result) => agentRunSpanCode(result.status, result.errorCode)
            },
            async (trace) => {
              responseTrace = trace
              return Schema.decodeUnknownSync(AgentRunResult)(
                await composition.services.agent.runTurn(input)
              )
            }
          )
      )
      await emitSafely(composition, {
        type: "agent_run",
        correlationId: output.correlationId,
        runId: output.runId,
        status: output.status,
        model: output.model,
        durationMs: output.durationMs,
        inputTokens: output.inputTokens,
        outputTokens: output.outputTokens
      })
      await emitSafely(composition, {
        type: "token_usage",
        correlationId: output.correlationId,
        runId: output.runId,
        feature,
        workflow: "agent_turn",
        provider: "openai-codex",
        model: output.model,
        status: output.status,
        inputTokens: output.inputTokens,
        outputTokens: output.outputTokens,
        toolCalls: output.toolCalls,
        durationMs: output.durationMs
      })
      return json(
        output,
        200,
        responseTrace === undefined ? {} : { traceparent: formatTraceparent(responseTrace) }
      )
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
