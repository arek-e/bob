import type { AgentRunRequest, AgentRunResult, DeviceLoginEvent } from "@bob/contracts/agent"
import { Layer } from "effect"
import { describe, expect, it, vi } from "vitest"

import type { AgentComposition } from "../src/composition.ts"
import { handleAgentHttp } from "../src/http.ts"

const runRequest: AgentRunRequest = {
  protocolVersion: 1,
  runId: "018e6f65-4d55-7a1b-8df4-4ee15ea1db9f",
  ownerId: "018e6f65-4d55-7a1b-8df4-4ee15ea1db90",
  correlationId: "018e6f65-4d55-7a1b-8df4-4ee15ea1db91",
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

function composition(
  authorized: boolean,
  allowedScope: "run" | "admin" | "both" = "both"
): AgentComposition {
  return {
    config: {} as never,
    layer: Layer.empty,
    services: {
      access: {
        verify: vi.fn(async (_request, scope) => {
          if (!authorized || (allowedScope !== "both" && allowedScope !== scope)) {
            throw new Error("access_denied")
          }
          return { subject: "", commonName: "service-token", scope }
        })
      },
      agent: {
        runTurn: vi.fn(async () => runResult),
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
      coreTools: { execute: vi.fn() },
      events: { emit: vi.fn() }
    }
  }
}

describe("agent HTTP boundary", () => {
  it("keeps health content-free and public", async () => {
    const response = await handleAgentHttp(new Request("http://agent/health"), composition(false))
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ healthy: true, service: "agent", version: 1 })
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
    const response = await handleAgentHttp(
      new Request("http://agent/v1/run", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(runRequest)
      }),
      target
    )
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual(runResult)
    expect(target.services.agent.runTurn).toHaveBeenCalledWith(runRequest)
    expect(target.services.access.verify).toHaveBeenCalledWith(expect.any(Request), "run")
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
