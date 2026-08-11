import { Schema } from "effect"
import { describe, expect, it } from "vitest"

import { AgentRunRequest, AgentRunResult } from "../src/agent.ts"

describe("AgentRunRequest rollout compatibility", () => {
  it("decodes a staged request that predates sourceMessageId", () => {
    const request = Schema.decodeUnknownSync(AgentRunRequest)({
      protocolVersion: 1,
      runId: "00000000-0000-4000-8000-000000000001",
      ownerId: "00000000-0000-4000-8000-000000000002",
      correlationId: "00000000-0000-4000-8000-000000000003",
      localTime: "2026-08-11T10:00:00.000Z",
      timeZone: "Europe/Stockholm",
      userText: "What is my routine?",
      contextItems: [],
      allowedTools: ["memory_search"],
      limits: {
        maxTurns: 4,
        maxToolCalls: 4,
        maxDurationMs: 60_000,
        maxResponseCharacters: 1_200
      }
    })

    expect(request.sourceMessageId).toBeUndefined()
  })

  it("decodes trusted search sources returned by the agent boundary", () => {
    const result = Schema.decodeUnknownSync(AgentRunResult)({
      protocolVersion: 1,
      runId: "00000000-0000-4000-8000-000000000001",
      correlationId: "00000000-0000-4000-8000-000000000003",
      status: "completed",
      responseText: "Your current routine is Full Body A.",
      sourceIds: ["fact-revision-1"],
      trustedToolSources: [
        {
          sourceId: "fact-revision-1",
          sourceLabel: "Owner message linked on 11 Aug 2026",
          occurredAt: "2026-08-11T10:00:00.000Z"
        }
      ],
      conflict: "none",
      model: "test-model",
      durationMs: 10,
      inputTokens: 10,
      outputTokens: 5,
      toolCalls: 1
    })

    expect(result.trustedToolSources).toEqual([
      {
        sourceId: "fact-revision-1",
        sourceLabel: "Owner message linked on 11 Aug 2026",
        occurredAt: "2026-08-11T10:00:00.000Z"
      }
    ])
  })

  it("decodes a staged agent result that predates trusted tool sources", () => {
    const result = Schema.decodeUnknownSync(AgentRunResult)({
      protocolVersion: 1,
      runId: "00000000-0000-4000-8000-000000000001",
      correlationId: "00000000-0000-4000-8000-000000000003",
      status: "completed",
      responseText: "Your current routine is Full Body A.",
      sourceIds: ["fact-revision-1"],
      conflict: "none",
      model: "test-model",
      durationMs: 10,
      inputTokens: 10,
      outputTokens: 5,
      toolCalls: 1
    })

    expect(result.trustedToolSources).toBeUndefined()
  })

  it("rejects oversized response source arrays at the HTTP boundary", () => {
    const sourceIds = Array.from({ length: 25 }, (_, index) => `source-${index}`)
    const trustedToolSources = sourceIds.map((sourceId) => ({
      sourceId,
      sourceLabel: `Source ${sourceId}`
    }))
    const result = {
      protocolVersion: 1,
      runId: "00000000-0000-4000-8000-000000000001",
      correlationId: "00000000-0000-4000-8000-000000000003",
      status: "completed",
      responseText: "Your current routine is Full Body A.",
      conflict: "none",
      model: "test-model",
      durationMs: 10,
      inputTokens: 10,
      outputTokens: 5,
      toolCalls: 1
    }

    expect(() =>
      Schema.decodeUnknownSync(AgentRunResult)({
        ...result,
        sourceIds
      })
    ).toThrow()
    expect(() =>
      Schema.decodeUnknownSync(AgentRunResult)({
        ...result,
        sourceIds: ["source-1"],
        trustedToolSources
      })
    ).toThrow()
  })
})
