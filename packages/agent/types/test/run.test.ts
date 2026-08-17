import { MAX_TOOL_RESULT_BYTES, ToolResult } from "@bob/capabilities-types/tools"
import { Schema } from "effect"
import { describe, expect, it } from "vitest"

import {
  AgentArtifact,
  AgentRunOperation,
  AgentRunRequest,
  AgentRunResult,
  AgentSteerRequest,
  AgentSteerResult,
  PriorToolReceipt
} from "../src/run.ts"

describe("AgentRunRequest rollout compatibility", () => {
  it("rejects a Tool result that cannot fit in one checkpoint", () => {
    expect(() =>
      Schema.decodeUnknownSync(ToolResult)({
        ok: true,
        code: "large_result",
        message: "Large result.",
        data: { text: "x".repeat(MAX_TOOL_RESULT_BYTES) }
      })
    ).toThrow()
  })

  it("accepts only the current durable Agent loop version", () => {
    const operation = {
      protocolVersion: 1,
      loopVersion: 1,
      runId: "00000000-0000-4000-8000-000000000001",
      sequence: 1,
      kind: "model",
      payload: { turnIndex: 1 }
    }
    expect(Schema.decodeUnknownSync(AgentRunOperation)(operation)).toEqual(operation)
    expect(() =>
      Schema.decodeUnknownSync(AgentRunOperation)({ ...operation, loopVersion: 2 })
    ).toThrow()
  })

  it("accepts a general structured plan artifact", () => {
    expect(
      Schema.decodeUnknownSync(AgentArtifact)({
        kind: "plan",
        title: "Friday errands",
        durationMinutes: 45,
        sections: [{ heading: "Before lunch", items: ["Collect the parcel"] }]
      })
    ).toMatchObject({ kind: "plan", title: "Friday errands" })
  })

  it("rejects legacy vertical artifacts from new Agent output", () => {
    expect(() =>
      Schema.decodeUnknownSync(AgentArtifact)({
        kind: "training_plan",
        title: "Legacy workout",
        durationMinutes: 30,
        sections: [{ heading: "Workout", items: ["Squats"] }]
      })
    ).toThrow()
  })

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

  it("exports only closed prior tool receipt confirmation fields", () => {
    const request = Schema.decodeUnknownSync(AgentRunRequest)({
      protocolVersion: 1,
      runId: "00000000-0000-4000-8000-000000000001",
      ownerId: "00000000-0000-4000-8000-000000000002",
      correlationId: "00000000-0000-4000-8000-000000000003",
      conversationTurnId: "00000000-0000-4000-8000-000000000004",
      conversationTurnRevision: 2,
      localTime: "2026-08-11T10:00:00.000Z",
      timeZone: "Europe/Stockholm",
      userText: "Actually, make it eight.",
      priorToolReceipts: [
        {
          origin: "same_turn",
          toolName: "reminder_create",
          arguments: { text: "PRIVATE_ARGUMENT_CANARY" },
          actionOutcome: "confirmed",
          message: "PRIVATE_RESULT_MESSAGE_CANARY",
          data: { reminderId: "PRIVATE_RESULT_DATA_CANARY" }
        }
      ],
      contextItems: [],
      allowedTools: ["reminder_create"],
      limits: {
        maxTurns: 4,
        maxToolCalls: 4,
        maxDurationMs: 60_000,
        maxResponseCharacters: 1_200
      }
    })

    expect(request.priorToolReceipts).toEqual([
      {
        origin: "same_turn",
        toolName: "reminder_create",
        actionOutcome: "confirmed"
      }
    ])
    expect(JSON.stringify(request.priorToolReceipts)).not.toMatch(
      /PRIVATE_|arguments|message|data/u
    )
  })

  it("keeps one closed receipt origin and rejects an unknown origin", () => {
    expect(
      Schema.decodeUnknownSync(PriorToolReceipt)({
        origin: "predecessor_turn",
        toolName: "reminder_create",
        actionOutcome: "confirmed"
      })
    ).toEqual({
      origin: "predecessor_turn",
      toolName: "reminder_create",
      actionOutcome: "confirmed"
    })

    expect(() =>
      Schema.decodeUnknownSync(PriorToolReceipt)({
        origin: "private_unreviewed_origin",
        toolName: "reminder_create",
        actionOutcome: "confirmed"
      })
    ).toThrow()

    expect(() =>
      Schema.decodeUnknownSync(PriorToolReceipt)({
        toolName: "reminder_create",
        actionOutcome: "confirmed"
      })
    ).toThrow()
  })

  it("accepts a domain-neutral Tool name", () => {
    expect(
      Schema.decodeUnknownSync(PriorToolReceipt)({
        origin: "same_turn",
        toolName: "private_reviewed_tool",
        actionOutcome: "confirmed"
      })
    ).toMatchObject({ toolName: "private_reviewed_tool" })
  })

  it("rejects an unknown action outcome", () => {
    expect(() =>
      Schema.decodeUnknownSync(PriorToolReceipt)({
        origin: "same_turn",
        toolName: "reminder_create",
        actionOutcome: "private_result"
      })
    ).toThrow()
  })

  it("accepts one closed unknown-action recovery receipt without private result data", () => {
    expect(
      Schema.decodeUnknownSync(PriorToolReceipt)({
        origin: "same_turn",
        toolName: "settings_update",
        actionOutcome: "unknown",
        message: "PRIVATE_MESSAGE_CANARY",
        data: { privateId: "PRIVATE_ID_CANARY" }
      })
    ).toEqual({
      origin: "same_turn",
      toolName: "settings_update",
      actionOutcome: "unknown"
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
