import type { AgentRunRequest, AgentRunResult, DeviceLoginEvent } from "@bob/agent-types/run"

import { BobAgent, type AgentRunDurability, type BobAgentShape } from "@bob/agent-types"
import { transitionalDeploymentProfile } from "@bob/deployment-profile-types/profiles"
import { withBobSpan, makeCaptureTelemetry } from "@bob/observability"
import { Effect, Layer, ManagedRuntime } from "effect"
import { afterEach, describe, expect, it, vi } from "vitest"

import { accessVerifierLayer } from "../src/access.ts"
import { coreToolClientLayer, type CoreToolClient } from "../src/core-tools.ts"
import { handleAgentHttp } from "../src/http.ts"

const runRequest: AgentRunRequest = {
  protocolVersion: 1,
  runId: "018e6f65-4d55-7a1b-8df4-4ee15ea1db9f",
  ownerId: "018e6f65-4d55-7a1b-8df4-4ee15ea1db90",
  correlationId: "018e6f65-4d55-7a1b-8df4-4ee15ea1db91",
  sourceMessageId: "018e6f65-4d55-7a1b-8df4-4ee15ea1db92",
  localTime: "2026-08-11T12:00:00.000Z",
  timeZone: "Europe/Stockholm",
  userText: "Remind me at 15:00.",
  contextItems: [],
  allowedTools: ["reminder_create"],
  deploymentProfileId: transitionalDeploymentProfile.profileId,
  capabilityCatalogueGeneration: transitionalDeploymentProfile.generation,
  limits: { maxTurns: 2, maxToolCalls: 1, maxDurationMs: 30_000, maxResponseCharacters: 500 }
}

const runResult: AgentRunResult = {
  protocolVersion: 1,
  runId: runRequest.runId,
  correlationId: runRequest.correlationId,
  status: "completed",
  responseText: "I set the reminder for 15:00 today.",
  model: "gpt-5.6-luna",
  durationMs: 25,
  inputTokens: 12,
  outputTokens: 9,
  toolCalls: 1
}

const runAttemptId = "018e6f65-4d55-7a1b-8df4-4ee15ea1db93"

const activeRuntimes: Array<{ readonly dispose: () => Promise<void> }> = []

type Mutable<Value> = { -readonly [Key in keyof Value]: Value[Key] }

afterEach(async () => {
  await Promise.all(activeRuntimes.splice(0).map((runtime) => runtime.dispose()))
})

function composition(authorized: boolean, allowedScope: "run" | "admin" | "both" = "both") {
  const telemetry = makeCaptureTelemetry({
    serviceName: "bob-agent-worker",
    serviceVersion: "0123456789abcdef0123456789abcdef01234567",
    deploymentEnvironment: "test"
  })
  const access = {
    verify: vi.fn(async (_request: Request, scope: "run" | "admin") => {
      if (!authorized || (allowedScope !== "both" && allowedScope !== scope)) {
        throw new Error("access_denied")
      }
      return { subject: "", commonName: "service-token", scope }
    })
  }
  const coreTools: Mutable<CoreToolClient> = {
    execute: vi.fn(() => Effect.die("not implemented in HTTP boundary test")),
    loadRunOperations: vi.fn(() => Effect.succeed([])),
    appendRunOperation: vi.fn(() => Effect.void),
    loadAttachment: vi.fn(() => Effect.die("not implemented in HTTP boundary test")),
    checkReadiness: vi.fn(() => Effect.succeed(true))
  }
  const agent: Mutable<BobAgentShape> = {
    runTurn: vi.fn(() =>
      withBobSpan(
        {
          name: "bob.agent.loop",
          correlationId: runRequest.correlationId,
          runId: runRequest.runId,
          feature: "reminders"
        },
        Effect.succeed(runResult)
      )
    ),
    runSmoke: vi.fn(() =>
      Effect.succeed({
        protocolVersion: 1 as const,
        status: "completed" as const,
        model: "gpt-5.6-luna",
        durationMs: 12
      })
    ),
    requestSteer: vi.fn(() => Effect.succeed({ status: "missing" as const })),
    getAuthStatus: vi.fn(() =>
      Effect.succeed({ configured: false, provider: "openai-codex" as const })
    ),
    startDeviceLogin: vi.fn(() =>
      Effect.succeed({
        type: "device_code" as const,
        verificationUri: "https://example.invalid/device",
        userCode: "ABC-12345",
        expiresAt: "2026-08-11T12:15:00.000Z"
      } satisfies DeviceLoginEvent)
    )
  }
  const runtime = ManagedRuntime.make(
    Layer.mergeAll(
      telemetry.layer,
      accessVerifierLayer(access),
      coreToolClientLayer(coreTools),
      Layer.succeed(BobAgent, agent)
    )
  )
  activeRuntimes.push(runtime)
  return {
    // SAFETY: This controlled test fixture matches the asserted contract used by this test.
    config: {} as never,
    profile: transitionalDeploymentProfile,
    runtime,
    telemetry,
    agent,
    services: {
      access,
      coreTools
    }
  }
}

describe("agent HTTP boundary", () => {
  it("keeps health content-free and public", async () => {
    const response = await handleAgentHttp(new Request("http://agent/health"), composition(false))
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ healthy: true, service: "agent-worker", version: 1 })
  })

  it("checks credentials and Core through the private readiness route", async () => {
    const target = composition(true)
    target.agent.getAuthStatus = vi.fn(() =>
      Effect.succeed({
        configured: true,
        provider: "openai-codex" as const,
        expiresAt: "2999-08-13T12:00:00.000Z"
      })
    )

    const response = await handleAgentHttp(new Request("http://agent/v1/admin/readiness"), target)

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      ready: true,
      checks: { credentials: "ready", core: "ready" },
      service: "agent-worker",
      version: 1,
      deploymentProfileId: transitionalDeploymentProfile.profileId,
      capabilityCatalogueGeneration: transitionalDeploymentProfile.generation
    })
    expect(target.services.access.verify).toHaveBeenCalledWith(expect.any(Request), "admin")
    expect(target.services.coreTools.checkReadiness).toHaveBeenCalledOnce()
  })

  it("reports unavailable credentials without exposing a cause", async () => {
    const target = composition(true)

    const response = await handleAgentHttp(new Request("http://agent/v1/admin/readiness"), target)

    expect(response.status).toBe(503)
    expect(await response.json()).toMatchObject({
      ready: false,
      checks: { credentials: "unavailable", core: "ready" }
    })
  })

  it("runs a content-free model smoke through the admin scope", async () => {
    const target = composition(true)

    const response = await handleAgentHttp(
      new Request("http://agent/v1/admin/smoke", { method: "POST" }),
      target
    )

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      protocolVersion: 1,
      status: "completed",
      model: "gpt-5.6-luna",
      durationMs: 12
    })
    expect(target.services.access.verify).toHaveBeenCalledWith(expect.any(Request), "admin")
    expect(target.agent.runSmoke).toHaveBeenCalledWith()
    expect(target.services.coreTools.loadRunOperations).not.toHaveBeenCalled()
  })

  it("does not let the run identity use model smoke administration", async () => {
    const target = composition(true, "run")

    const response = await handleAgentHttp(
      new Request("http://agent/v1/admin/smoke", { method: "POST" }),
      target
    )

    expect(response.status).toBe(401)
    expect(target.agent.runSmoke).not.toHaveBeenCalled()
  })

  it("reports a failed model smoke without model output", async () => {
    const target = composition(true)
    target.agent.runSmoke = vi.fn(() =>
      Effect.succeed({
        protocolVersion: 1 as const,
        status: "failed" as const,
        model: "gpt-5.6-luna",
        durationMs: 12,
        errorCode: "invalid_output" as const
      })
    )

    const response = await handleAgentHttp(
      new Request("http://agent/v1/admin/smoke", { method: "POST" }),
      target
    )

    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({
      protocolVersion: 1,
      status: "failed",
      model: "gpt-5.6-luna",
      durationMs: 12,
      errorCode: "invalid_output"
    })
  })

  it("rejects a run before parsing its body when Access rejects it", async () => {
    const target = composition(false)
    const response = await handleAgentHttp(
      new Request("http://agent/v1/run", { method: "POST", body: "private text" }),
      target
    )
    expect(response.status).toBe(401)
    expect(target.agent.runTurn).not.toHaveBeenCalled()
  })

  it("validates and returns one bounded run", async () => {
    const target = composition(true)
    const incomingTrace = "00-11111111111111111111111111111111-2222222222222222-01"
    const response = await handleAgentHttp(
      new Request("http://agent/v1/run", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          traceparent: incomingTrace,
          "x-bob-run-attempt-id": runAttemptId
        },
        body: JSON.stringify(runRequest)
      }),
      target
    )
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual(runResult)
    expect(response.headers.get("traceparent")).toMatch(
      /^00-11111111111111111111111111111111-[0-9a-f]{16}-01$/u
    )
    const runSpan = target.telemetry.finishedSpans().find((span) => span.name === "bob.agent.run")
    expect(runSpan).toMatchObject({
      traceId: "11111111111111111111111111111111",
      parentSpanId: "2222222222222222",
      outcome: "completed"
    })
    expect(response.headers.get("traceparent")).toBe(`00-${runSpan?.traceId}-${runSpan?.spanId}-01`)
    expect(
      target.telemetry.finishedSpans().filter((span) => span.name === "bob.agent.run")
    ).toHaveLength(1)
    expect(
      target.telemetry.finishedSpans().find((span) => span.name === "bob.agent.loop")?.parentSpanId
    ).toBe(runSpan?.spanId)
    expect(target.agent.runTurn).toHaveBeenCalledWith(
      runRequest,
      expect.objectContaining({ operations: [] })
    )
    expect(target.services.access.verify).toHaveBeenCalledWith(expect.any(Request), "run")
    expect(target.telemetry.healthEvents()).toContainEqual(
      expect.objectContaining({
        type: "token_usage",
        feature: "reminders",
        inputTokens: 12,
        outputTokens: 9
      })
    )
  })

  it("rejects a run from a different capability catalogue", async () => {
    const target = composition(true)
    const response = await handleAgentHttp(
      new Request("http://agent/v1/run", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-bob-run-attempt-id": runAttemptId
        },
        body: JSON.stringify({
          ...runRequest,
          capabilityCatalogueGeneration: "capability-v2:0000000000000000"
        })
      }),
      target
    )

    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({ code: "capability_catalogue_mismatch" })
    expect(target.agent.runTurn).not.toHaveBeenCalled()
  })

  it("rejects a new run without a deployment profile identity", async () => {
    const target = composition(true)
    const {
      deploymentProfileId: _profile,
      capabilityCatalogueGeneration: _generation,
      ...input
    } = runRequest
    const response = await handleAgentHttp(
      new Request("http://agent/v1/run", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input)
      }),
      target
    )

    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({ code: "deployment_profile_required" })
  })

  it("requires an active attempt identity for a new run", async () => {
    const target = composition(true)
    const response = await handleAgentHttp(
      new Request("http://agent/v1/run", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(runRequest)
      }),
      target
    )

    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({ code: "agent_run_attempt_required" })
    expect(target.agent.runTurn).not.toHaveBeenCalled()
  })

  it("requires an active attempt identity for a legacy snapshot replay", async () => {
    const target = composition(true)
    const {
      deploymentProfileId: _profile,
      capabilityCatalogueGeneration: _generation,
      ...legacyRequest
    } = runRequest
    const response = await handleAgentHttp(
      new Request("http://agent/v1/run", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...legacyRequest, legacySnapshotReplay: true })
      }),
      target
    )

    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({ code: "agent_run_attempt_required" })
    expect(target.services.coreTools.loadRunOperations).not.toHaveBeenCalled()
    expect(target.agent.runTurn).not.toHaveBeenCalled()
  })

  it("replays a legacy snapshot through durable operations", async () => {
    const target = composition(true)
    const operation = {
      protocolVersion: 1 as const,
      loopVersion: 1 as const,
      runId: runRequest.runId,
      sequence: 1,
      kind: "final" as const,
      payload: runResult
    }
    target.services.coreTools.loadRunOperations = vi.fn(() => Effect.succeed([operation]))
    target.agent.runTurn = vi.fn((_input: AgentRunRequest, durability?: AgentRunDurability) =>
      Effect.gen(function* () {
        expect(durability).toBeDefined()
        yield* durability!.append(operation).pipe(Effect.orDie)
        return runResult
      })
    )
    const {
      deploymentProfileId: _profile,
      capabilityCatalogueGeneration: _generation,
      ...legacyRequest
    } = runRequest

    const response = await handleAgentHttp(
      new Request("http://agent/v1/run", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-bob-run-attempt-id": runAttemptId
        },
        body: JSON.stringify({ ...legacyRequest, legacySnapshotReplay: true })
      }),
      target
    )

    expect(response.status).toBe(200)
    expect(target.services.coreTools.loadRunOperations).toHaveBeenCalledWith(
      runRequest.runId,
      runAttemptId
    )
    expect(target.agent.runTurn).toHaveBeenCalledWith(
      expect.objectContaining({ legacySnapshotReplay: true }),
      expect.objectContaining({ operations: [operation] })
    )
    expect(target.services.coreTools.appendRunOperation).toHaveBeenCalledWith(
      operation,
      runAttemptId
    )
  })

  it("fails closed when durable operations cannot load", async () => {
    const target = composition(true)
    target.services.coreTools.loadRunOperations = vi.fn(() => Effect.die("core unavailable"))
    const response = await handleAgentHttp(
      new Request("http://agent/v1/run", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-bob-run-attempt-id": runAttemptId
        },
        body: JSON.stringify(runRequest)
      }),
      target
    )

    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({ code: "agent_run_checkpoint_unavailable" })
    expect(target.agent.runTurn).not.toHaveBeenCalled()
  })

  it("rejects a run from a different deployment profile", async () => {
    const target = composition(true)
    const response = await handleAgentHttp(
      new Request("http://agent/v1/run", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...runRequest, deploymentProfileId: "core" })
      }),
      target
    )

    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({ code: "deployment_profile_mismatch" })
  })

  it("passes request cancellation to the agent run", async () => {
    const controller = new AbortController()
    controller.abort("client_disconnected")
    const target = composition(true)
    target.agent.runTurn = vi.fn(() =>
      Effect.succeed({
        ...runResult,
        status: "cancelled" as const,
        errorCode: "cancelled" as const
      })
    )

    const response = await handleAgentHttp(
      new Request("http://agent/v1/run", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-bob-run-attempt-id": runAttemptId
        },
        body: JSON.stringify(runRequest),
        signal: controller.signal
      }),
      target
    )

    expect(await response.json()).toMatchObject({ status: "cancelled", errorCode: "cancelled" })
  })

  it("steers one active run through the authenticated run scope", async () => {
    const target = composition(true)
    target.agent.requestSteer = vi.fn(() => Effect.succeed({ status: "aborted_model" as const }))
    const traceparent = "00-33333333333333333333333333333333-4444444444444444-01"

    const response = await handleAgentHttp(
      new Request("http://agent/v1/steer", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          traceparent,
          "x-bob-correlation-id": runRequest.correlationId
        },
        body: JSON.stringify({ runId: runRequest.runId })
      }),
      target
    )

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ status: "aborted_model" })
    expect(target.agent.requestSteer).toHaveBeenCalledWith(runRequest.runId)
    expect(target.services.access.verify).toHaveBeenCalledWith(expect.any(Request), "run")
    const abort = target.telemetry.finishedSpans().find((span) => span.name === "bob.agent.abort")
    expect(abort).toMatchObject({
      traceId: "33333333333333333333333333333333",
      parentSpanId: "4444444444444444",
      kind: "server",
      attributes: expect.objectContaining({
        "bob.correlation.id": runRequest.correlationId,
        "bob.run.id": runRequest.runId
      }),
      events: [
        {
          name: "bob.decision.steering",
          attributes: expect.objectContaining({
            "bob.decision.code": "abort_model",
            "bob.decision.outcome": "applied"
          })
        }
      ]
    })
  })

  it("returns a device code only through the private admin route", async () => {
    const target = composition(true)
    const response = await handleAgentHttp(
      new Request("http://agent/v1/admin/auth/device-login", { method: "POST" }),
      target
    )
    expect(response.status).toBe(202)
    expect(await response.json()).toMatchObject({ type: "device_code", userCode: "ABC-12345" })
    expect(target.services.access.verify).toHaveBeenCalledWith(expect.any(Request), "admin")
  })

  it("does not let the run identity use device-login administration", async () => {
    const target = composition(true, "run")
    const response = await handleAgentHttp(
      new Request("http://agent/v1/admin/auth/device-login", { method: "POST" }),
      target
    )
    expect(response.status).toBe(401)
    expect(target.agent.startDeviceLogin).not.toHaveBeenCalled()
  })

  it("rejects an oversized request body", async () => {
    const target = composition(true)
    const response = await handleAgentHttp(
      new Request("http://agent/v1/run", {
        method: "POST",
        headers: { "content-length": String(64 * 1024 + 1) },
        body: "{}"
      }),
      target
    )

    expect(response.status).toBe(413)
    expect(await response.json()).toEqual({ code: "body_too_large" })
    expect(target.agent.runTurn).not.toHaveBeenCalled()
  })
})
