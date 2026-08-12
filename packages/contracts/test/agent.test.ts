import { Schema } from "effect"
import { describe, expect, it } from "vitest"

import {
  AgentRunRequest,
  AgentRunResult,
  AgentSteerRequest,
  AgentSteerResult
} from "../src/agent.ts"

describe("AgentRunRequest rollout compatibility", () => {
  it("decodes ordered messages from the current turn", () => {
    const request = Schema.decodeUnknownSync(AgentRunRequest)({
      protocolVersion: 1,
      runId: "00000000-0000-4000-8000-000000000001",
      ownerId: "00000000-0000-4000-8000-000000000002",
      correlationId: "00000000-0000-4000-8000-000000000003",
      sourceMessageId: "00000000-0000-4000-8000-000000000005",
      localTime: "2026-08-11T10:00:00.000Z",
      timeZone: "Europe/Stockholm",
      userText: "List them.",
      currentTurnMessages: [
        {
          sourceMessageId: "00000000-0000-4000-8000-000000000004",
          text: "I lost my reminders."
        },
        {
          sourceMessageId: "00000000-0000-4000-8000-000000000005",
          text: "List them."
        }
      ],
      contextItems: [],
      allowedTools: ["reminder_list"],
      limits: {
        maxTurns: 4,
        maxToolCalls: 4,
        maxDurationMs: 60_000,
        maxResponseCharacters: 1_200
      }
    })

    expect(request.currentTurnMessages?.map((message) => message.text)).toEqual([
      "I lost my reminders.",
      "List them."
    ])
  })

  it("rejects an oversized current turn", () => {
    const currentTurnMessages = Array.from({ length: 13 }, (_, index) => ({
      sourceMessageId: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
      text: `Message ${index + 1}`
    }))

    expect(() =>
      Schema.decodeUnknownSync(AgentRunRequest)({
        protocolVersion: 1,
        runId: "00000000-0000-4000-8000-000000000001",
        ownerId: "00000000-0000-4000-8000-000000000002",
        correlationId: "00000000-0000-4000-8000-000000000003",
        sourceMessageId: currentTurnMessages.at(-1)?.sourceMessageId,
        localTime: "2026-08-11T10:00:00.000Z",
        timeZone: "Europe/Stockholm",
        userText: currentTurnMessages.at(-1)?.text,
        currentTurnMessages,
        contextItems: [],
        allowedTools: [],
        limits: {
          maxTurns: 4,
          maxToolCalls: 4,
          maxDurationMs: 60_000,
          maxResponseCharacters: 1_200
        }
      })
    ).toThrow()
  })

  it("rejects a current turn that exceeds the total character limit", () => {
    expect(() =>
      Schema.decodeUnknownSync(AgentRunRequest)({
        protocolVersion: 1,
        runId: "00000000-0000-4000-8000-000000000001",
        ownerId: "00000000-0000-4000-8000-000000000002",
        correlationId: "00000000-0000-4000-8000-000000000003",
        sourceMessageId: "00000000-0000-4000-8000-000000000005",
        localTime: "2026-08-11T10:00:00.000Z",
        timeZone: "Europe/Stockholm",
        userText: "b".repeat(4_001),
        currentTurnMessages: [
          {
            sourceMessageId: "00000000-0000-4000-8000-000000000004",
            text: "a".repeat(4_000)
          },
          {
            sourceMessageId: "00000000-0000-4000-8000-000000000005",
            text: "b".repeat(4_001)
          }
        ],
        contextItems: [],
        allowedTools: [],
        limits: {
          maxTurns: 4,
          maxToolCalls: 4,
          maxDurationMs: 60_000,
          maxResponseCharacters: 1_200
        }
      })
    ).toThrow()
  })

  it("rejects current-turn messages whose final text is not the response target", () => {
    expect(() =>
      Schema.decodeUnknownSync(AgentRunRequest)({
        protocolVersion: 1,
        runId: "00000000-0000-4000-8000-000000000001",
        ownerId: "00000000-0000-4000-8000-000000000002",
        correlationId: "00000000-0000-4000-8000-000000000003",
        sourceMessageId: "00000000-0000-4000-8000-000000000005",
        localTime: "2026-08-11T10:00:00.000Z",
        timeZone: "Europe/Stockholm",
        userText: "A different target.",
        currentTurnMessages: [
          {
            sourceMessageId: "00000000-0000-4000-8000-000000000005",
            text: "List them."
          }
        ],
        contextItems: [],
        allowedTools: [],
        limits: {
          maxTurns: 4,
          maxToolCalls: 4,
          maxDurationMs: 60_000,
          maxResponseCharacters: 1_200
        }
      })
    ).toThrow()
  })

  it("rejects current-turn messages whose final identifier is not the response target", () => {
    expect(() =>
      Schema.decodeUnknownSync(AgentRunRequest)({
        protocolVersion: 1,
        runId: "00000000-0000-4000-8000-000000000001",
        ownerId: "00000000-0000-4000-8000-000000000002",
        correlationId: "00000000-0000-4000-8000-000000000003",
        sourceMessageId: "00000000-0000-4000-8000-000000000006",
        localTime: "2026-08-11T10:00:00.000Z",
        timeZone: "Europe/Stockholm",
        userText: "List them.",
        currentTurnMessages: [
          {
            sourceMessageId: "00000000-0000-4000-8000-000000000005",
            text: "List them."
          }
        ],
        contextItems: [],
        allowedTools: [],
        limits: {
          maxTurns: 4,
          maxToolCalls: 4,
          maxDurationMs: 60_000,
          maxResponseCharacters: 1_200
        }
      })
    ).toThrow()
  })

  it("decodes paired conversation-turn identity", () => {
    const request = Schema.decodeUnknownSync(AgentRunRequest)({
      protocolVersion: 1,
      runId: "00000000-0000-4000-8000-000000000001",
      ownerId: "00000000-0000-4000-8000-000000000002",
      correlationId: "00000000-0000-4000-8000-000000000003",
      conversationTurnId: "00000000-0000-4000-8000-000000000004",
      conversationTurnRevision: 2,
      localTime: "2026-08-11T10:00:00.000Z",
      timeZone: "Europe/Stockholm",
      userText: "List reminders.",
      contextItems: [],
      allowedTools: [],
      limits: {
        maxTurns: 4,
        maxToolCalls: 4,
        maxDurationMs: 60_000,
        maxResponseCharacters: 1_200
      }
    })

    expect(request).toMatchObject({
      conversationTurnId: "00000000-0000-4000-8000-000000000004",
      conversationTurnRevision: 2
    })
  })

  it("rejects an incomplete conversation-turn identity", () => {
    expect(() =>
      Schema.decodeUnknownSync(AgentRunRequest)({
        protocolVersion: 1,
        runId: "00000000-0000-4000-8000-000000000001",
        ownerId: "00000000-0000-4000-8000-000000000002",
        correlationId: "00000000-0000-4000-8000-000000000003",
        conversationTurnId: "00000000-0000-4000-8000-000000000004",
        localTime: "2026-08-11T10:00:00.000Z",
        timeZone: "Europe/Stockholm",
        userText: "List reminders.",
        contextItems: [],
        allowedTools: [],
        limits: {
          maxTurns: 4,
          maxToolCalls: 4,
          maxDurationMs: 60_000,
          maxResponseCharacters: 1_200
        }
      })
    ).toThrow()
  })

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

describe("Agent steering contract", () => {
  it("accepts only the closed steering outcomes", () => {
    expect(
      Schema.decodeUnknownSync(AgentSteerRequest)({
        runId: "00000000-0000-4000-8000-000000000001"
      })
    ).toEqual({ runId: "00000000-0000-4000-8000-000000000001" })
    for (const status of ["aborted_model", "queued", "missing"] as const) {
      expect(Schema.decodeUnknownSync(AgentSteerResult)({ status })).toEqual({ status })
    }
    expect(() => Schema.decodeUnknownSync(AgentSteerResult)({ status: "aborted_tool" })).toThrow()
  })
})
