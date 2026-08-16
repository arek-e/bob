import { describe, expect, it } from "vitest"

import { assertAgentResultIdentity } from "../src/process-inbound.ts"

const request = {
  protocolVersion: 1 as const,
  runId: "00000000-0000-4000-8000-000000000001",
  ownerId: "00000000-0000-4000-8000-000000000002",
  correlationId: "00000000-0000-4000-8000-000000000003",
  sourceMessageId: "00000000-0000-4000-8000-000000000004",
  localTime: "2026-08-11T10:00:00.000Z",
  timeZone: "Europe/Stockholm",
  userText: "Hello",
  contextItems: [],
  allowedTools: [],
  limits: {
    maxTurns: 4,
    maxToolCalls: 4,
    maxDurationMs: 60_000,
    maxResponseCharacters: 1_200
  }
}

const result = {
  protocolVersion: 1 as const,
  runId: request.runId,
  correlationId: request.correlationId,
  status: "completed" as const,
  responseText: "Hello.",
  sourceIds: [],
  conflict: "none" as const,
  model: "test-model",
  durationMs: 10,
  inputTokens: 10,
  outputTokens: 5,
  toolCalls: 0
}

describe("agent result identity", () => {
  it("accepts only the requested run and correlation IDs", () => {
    expect(assertAgentResultIdentity(request, result)).toBe(result)
    expect(() =>
      assertAgentResultIdentity(request, {
        ...result,
        runId: "00000000-0000-4000-8000-000000000099"
      })
    ).toThrow("policy")
    expect(() =>
      assertAgentResultIdentity(request, {
        ...result,
        correlationId: "00000000-0000-4000-8000-000000000099"
      })
    ).toThrow("policy")
  })
})
