import { AgentCheckpointError, BobAgent } from "@bob/agent-types"
import {
  AgentRunRequest,
  AgentRunResult,
  AgentSmokeResult,
  AgentSteerRequest,
  AgentSteerResult,
  DeviceLoginEvent,
  type AgentRunOperation
} from "@bob/core-types/agent"
import { featureForTools } from "@bob/observability/attribution"
import { emitHealth, recordDecision, withBobSpan } from "@bob/observability/effect"
import { externalParentFromTraceparent, formatTraceparent } from "@bob/observability/propagation"
import { Effect, Option, Schema } from "effect"

import type { AgentComposition } from "./composition.ts"

import { AccessVerifier } from "./access.ts"
import { CoreToolClient } from "./core-tools.ts"

const MAX_BODY_BYTES = 64 * 1024
const securityHeaders = {
  "cache-control": "no-store",
  "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff"
}

function json<Value>(
  value: Value,
  status = 200,
  extraHeaders: Readonly<Record<string, string>> = {}
): Response {
  return Response.json(value, { status, headers: { ...securityHeaders, ...extraHeaders } })
}

async function readJson(request: Request): Promise<typeof Schema.Json.Type> {
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
  return JSON.parse(new TextDecoder().decode(body))
}

export async function handleAgentHttp(
  request: Request,
  composition: AgentComposition
): Promise<Response> {
  const url = new URL(request.url)
  if (request.method === "GET" && url.pathname === "/health") {
    return json({ healthy: true, service: "agent-worker", version: 1 })
  }

  try {
    await composition.runtime.runPromise(
      AccessVerifier.use((access) =>
        Effect.tryPromise({
          try: () =>
            access.verify(request, url.pathname.startsWith("/v1/admin/") ? "admin" : "run"),
          catch: (error) => error
        })
      )
    )
  } catch {
    return json({ code: "unauthorized" }, 401)
  }

  try {
    if (request.method === "GET" && url.pathname === "/v1/admin/readiness") {
      const readiness = await composition.runtime.runPromise(
        Effect.all(
          {
            auth: BobAgent.use((agent) => agent.getAuthStatus()).pipe(Effect.option),
            core: CoreToolClient.use((client) => client.checkReadiness()).pipe(Effect.option)
          },
          { concurrency: "unbounded" }
        ),
        { signal: request.signal }
      )
      const authStatus = Option.getOrUndefined(readiness.auth)
      const credentialsReady =
        authStatus?.configured === true &&
        authStatus.expiresAt !== undefined &&
        Date.parse(authStatus.expiresAt) > Date.now()
      const coreReady = Option.getOrElse(readiness.core, () => false)
      return json(
        {
          ready: credentialsReady && coreReady,
          checks: {
            credentials: credentialsReady ? "ready" : "unavailable",
            core: coreReady ? "ready" : "unavailable"
          },
          service: "agent-worker",
          version: 1,
          deploymentProfileId: composition.profile.profileId,
          capabilityCatalogueGeneration: composition.profile.generation
        },
        credentialsReady && coreReady ? 200 : 503
      )
    }
    if (request.method === "POST" && url.pathname === "/v1/admin/smoke") {
      const output = Schema.decodeUnknownSync(AgentSmokeResult)(
        await composition.runtime.runPromise(
          BobAgent.use((agent) => agent.runSmoke()),
          {
            signal: request.signal
          }
        )
      )
      return json(output, output.status === "completed" ? 200 : 503)
    }
    if (request.method === "POST" && url.pathname === "/v1/run") {
      const input = Schema.decodeUnknownSync(AgentRunRequest)(await readJson(request))
      const attemptHeader = request.headers.get("x-bob-run-attempt-id")
      if (
        input.legacySnapshotReplay !== true &&
        (input.deploymentProfileId === undefined ||
          input.capabilityCatalogueGeneration === undefined)
      ) {
        return json({ code: "deployment_profile_required" }, 409)
      }
      if (
        input.deploymentProfileId !== undefined &&
        input.deploymentProfileId !== composition.profile.profileId
      ) {
        return json({ code: "deployment_profile_mismatch" }, 409)
      }
      if (
        input.capabilityCatalogueGeneration !== undefined &&
        input.capabilityCatalogueGeneration !== composition.profile.generation
      ) {
        return json({ code: "capability_catalogue_mismatch" }, 409)
      }
      if (attemptHeader === null) {
        return json({ code: "agent_run_attempt_required" }, 409)
      }
      const attemptId = Schema.decodeUnknownSync(Schema.String.check(Schema.isUUID()))(
        attemptHeader
      )
      let operations: readonly AgentRunOperation[]
      try {
        operations = await composition.runtime.runPromise(
          CoreToolClient.use((client) => client.loadRunOperations(input.runId, attemptId)),
          { signal: request.signal }
        )
      } catch {
        return json({ code: "agent_run_checkpoint_unavailable" }, 503)
      }
      const durability = {
        operations,
        append: (operation: (typeof operations)[number]) =>
          composition.services.coreTools.appendRunOperation(operation, attemptId).pipe(
            Effect.mapError(
              (cause) =>
                new AgentCheckpointError({
                  message: "Agent checkpoint append failed",
                  cause
                })
            )
          )
      }
      const feature = featureForTools(composition.profile, input.allowedTools)
      const parent = externalParentFromTraceparent(request.headers.get("traceparent"))
      const run = withBobSpan(
        {
          name: "bob.agent.run",
          correlationId: input.correlationId,
          runId: input.runId,
          feature
        },
        Effect.gen(function* () {
          const span = yield* Effect.currentSpan
          const output = Schema.decodeUnknownSync(AgentRunResult)(
            yield* BobAgent.use((agent) => agent.runTurn(input, durability))
          )
          yield* emitHealth({
            type: "agent_run",
            correlationId: output.correlationId,
            runId: output.runId,
            status: output.status,
            model: output.model,
            durationMs: output.durationMs,
            inputTokens: output.inputTokens,
            outputTokens: output.outputTokens
          })
          yield* emitHealth({
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
          return { output, traceparent: formatTraceparent(span) }
        })
      )
      const tracedRun = parent === undefined ? run : Effect.withParentSpan(run, parent)
      const result = await composition.runtime.runPromise(tracedRun, { signal: request.signal })
      return json(result.output, 200, { traceparent: result.traceparent })
    }
    if (request.method === "POST" && url.pathname === "/v1/steer") {
      const input = Schema.decodeUnknownSync(AgentSteerRequest)(await readJson(request))
      const correlationId = Schema.decodeUnknownSync(Schema.String.check(Schema.isUUID()))(
        request.headers.get("x-bob-correlation-id") ?? input.runId
      )
      const parent = externalParentFromTraceparent(request.headers.get("traceparent"))
      const abort = withBobSpan(
        {
          name: "bob.agent.abort",
          correlationId,
          runId: input.runId,
          feature: "assistant"
        },
        Effect.gen(function* () {
          const output = Schema.decodeUnknownSync(AgentSteerResult)(
            yield* BobAgent.use((agent) => agent.requestSteer(input.runId))
          )
          yield* recordDecision({
            name: "bob.decision.steering",
            code:
              output.status === "aborted_model"
                ? "abort_model"
                : output.status === "queued"
                  ? "wait_effect"
                  : "stale_reply_suppressed",
            outcome: output.status === "missing" ? "skipped" : "applied"
          })
          return output
        })
      )
      return json(
        await composition.runtime.runPromise(
          parent === undefined ? abort : Effect.withParentSpan(abort, parent)
        )
      )
    }
    if (request.method === "GET" && url.pathname === "/v1/admin/auth/status") {
      return json(
        await composition.runtime.runPromise(BobAgent.use((agent) => agent.getAuthStatus()))
      )
    }
    if (request.method === "POST" && url.pathname === "/v1/admin/auth/device-login") {
      const event = Schema.decodeUnknownSync(DeviceLoginEvent)(
        await composition.runtime.runPromise(BobAgent.use((agent) => agent.startDeviceLogin()))
      )
      return json(event, event.type === "failed" ? 409 : 202)
    }
    return json({ code: "not_found" }, 404)
  } catch (error) {
    const tooLarge = error instanceof Error && error.message === "body_too_large"
    return json({ code: tooLarge ? "body_too_large" : "invalid_request" }, tooLarge ? 413 : 400)
  }
}
