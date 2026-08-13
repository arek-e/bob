import type { AgentRunRequest, AgentRunResult, DeviceLoginEvent } from "@bob/contracts/agent"

import { withBobSpan } from "@bob/observability/effect"
import { makeCaptureTelemetry } from "@bob/observability/testing"
import { Effect, Layer, ManagedRuntime } from "effect"
import { afterEach, describe, expect, it, vi } from "vitest"

import type { AgentComposition } from "../src/composition.ts"

import { accessVerifierLayer } from "../src/access.ts"
import { coreToolClientLayer } from "../src/core-tools.ts"
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

const activeRuntimes: Array<{ readonly dispose: () => Promise<void> }> = []

afterEach(async () => {
  await Promise.all(activeRuntimes.splice(0).map((runtime) => runtime.dispose()))
})

function composition(
  authorized: boolean,
  allowedScope: "run" | "admin" | "both" = "both"
): AgentComposition & {
  readonly telemetry: ReturnType<typeof makeCaptureTelemetry>
} {
  const telemetry = makeCaptureTelemetry({
    serviceName: "bob-agent",
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
  const coreTools = {
    executeEffect: vi.fn(() => Effect.die("not implemented in HTTP boundary test")),
    execute: vi.fn(),
    checkReadiness: vi.fn(async () => true)
  }
  const runtime = ManagedRuntime.make(
    Layer.mergeAll(telemetry.layer, accessVerifierLayer(access), coreToolClientLayer(coreTools))
  )
  activeRuntimes.push(runtime)
  return {
    config: {} as never,
    runtime,
    telemetry,
    services: {
      access,
      agent: {
        runTurnEffect: vi.fn(() =>
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
        runTurn: vi.fn(async () => runResult),
        requestSteer: vi.fn(() => ({ status: "missing" as const })),
        getAuthStatus: vi.fn(async () => ({
          configured: false,
          provider: "openai-codex" as const
        })),
        startDeviceLogin: vi.fn(async (): Promise<DeviceLoginEvent> => ({
          type: "device_code",
          verificationUri: "https://example.invalid/device",
          userCode: "ABC-12345",
          expiresAt: "2026-08-11T12:15:00.000Z"
        }))
      },
      coreTools
    }
  }
}

describe("agent HTTP boundary", () => {
  it("keeps health content-free and public", async () => {
    const response = await handleAgentHttp(new Request("http://agent/health"), composition(false))
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ healthy: true, service: "agent", version: 1 })
  })

  it("checks credentials and Core through the private readiness route", async () => {
    const target = composition(true)
    target.services.agent.getAuthStatus = vi.fn(async () => ({
      configured: true,
      provider: "openai-codex" as const,
      expiresAt: "2999-08-13T12:00:00.000Z"
    }))

    const response = await handleAgentHttp(new Request("http://agent/v1/admin/readiness"), target)

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      ready: true,
      checks: { credentials: "ready", core: "ready" },
      service: "agent",
      version: 1
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

  it("rejects a run before parsing its body when Access rejects it", async () => {
    const target = composition(false)
    const response = await handleAgentHttp(
      new Request("http://agent/v1/run", { method: "POST", body: "private text" }),
      target
    )
    expect(response.status).toBe(401)
    expect(target.services.agent.runTurn).not.toHaveBeenCalled()
  })

  it("validates and returns one bounded run", async () => {
    const target = composition(true)
    const incomingTrace = "00-11111111111111111111111111111111-2222222222222222-01"
    const response = await handleAgentHttp(
      new Request("http://agent/v1/run", {
        method: "POST",
        headers: { "content-type": "application/json", traceparent: incomingTrace },
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
    expect(target.services.agent.runTurnEffect).toHaveBeenCalledWith(
      runRequest,
      expect.any(AbortSignal)
    )
    expect(target.services.agent.runTurn).not.toHaveBeenCalled()
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

  it("passes request cancellation to the agent run", async () => {
    const controller = new AbortController()
    controller.abort("client_disconnected")
    const target = composition(true)
    target.services.agent.runTurnEffect = vi.fn((_input, signal) => {
      const output: AgentRunResult =
        signal?.aborted === true
          ? { ...runResult, status: "cancelled", errorCode: "cancelled" }
          : runResult
      return Effect.succeed(output)
    })

    const response = await handleAgentHttp(
      new Request("http://agent/v1/run", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(runRequest),
        signal: controller.signal
      }),
      target
    )

    expect(await response.json()).toMatchObject({ status: "cancelled", errorCode: "cancelled" })
  })

  it("steers one active run through the authenticated run scope", async () => {
    const target = composition(true)
    target.services.agent.requestSteer = vi.fn(() => ({ status: "aborted_model" as const }))
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
    expect(target.services.agent.requestSteer).toHaveBeenCalledWith(runRequest.runId)
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
    expect(target.services.agent.startDeviceLogin).not.toHaveBeenCalled()
  })
})
