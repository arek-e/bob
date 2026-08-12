import { describe, expect, it } from "vitest"

import { selectAgentResponse } from "../src/modules/policy/agent-response.ts"

const request = {
  protocolVersion: 1 as const,
  runId: "00000000-0000-4000-8000-000000000001",
  ownerId: "00000000-0000-4000-8000-000000000002",
  correlationId: "00000000-0000-4000-8000-000000000003",
  sourceMessageId: "00000000-0000-4000-8000-000000000004",
  localTime: "2026-08-11T10:00:00.000Z",
  timeZone: "Europe/Stockholm",
  userText: "Create a reminder for tomorrow.",
  contextItems: [],
  allowedTools: ["reminder_create" as const],
  limits: {
    maxTurns: 4,
    maxToolCalls: 4,
    maxDurationMs: 60_000,
    maxResponseCharacters: 1_200
  }
}

describe("agent response selection", () => {
  it("renders approved source labels from the request boundary", () => {
    const groundedRequest = {
      ...request,
      contextItems: [
        {
          kind: "fact" as const,
          text: "Training day is Tuesday.",
          instruction: false as const,
          conflict: false,
          sources: [{ sourceId: "fact-1", sourceLabel: "Owner message linked on 11 Aug 2026" }]
        }
      ]
    }

    expect(
      selectAgentResponse(
        {
          protocolVersion: 1,
          runId: request.runId,
          correlationId: request.correlationId,
          status: "completed",
          responseText: "Your training day is Tuesday.",
          sourceIds: ["fact-1"],
          conflict: "none",
          model: "test-model",
          durationMs: 10,
          inputTokens: 10,
          outputTokens: 5,
          toolCalls: 0
        },
        groundedRequest
      )
    ).toEqual({
      text: "Your training day is Tuesday.\nSource: Owner message linked on 11 Aug 2026",
      reasonCode: "agent_reply"
    })
  })

  it("renders a trusted source returned by memory search", () => {
    expect(
      selectAgentResponse(
        {
          protocolVersion: 1,
          runId: request.runId,
          correlationId: request.correlationId,
          status: "completed",
          responseText: "You prefer morning training.",
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
        },
        request
      )
    ).toEqual({
      text: "You prefer morning training.\nSource: Owner message linked on 11 Aug 2026",
      reasonCode: "agent_reply"
    })
  })

  it("delivers a trusted empty reminder record set", () => {
    expect(
      selectAgentResponse(
        {
          protocolVersion: 1,
          runId: request.runId,
          correlationId: request.correlationId,
          status: "completed",
          responseText: "You have no active reminders.",
          sourceIds: ["bob:active-reminders"],
          trustedToolSources: [
            {
              sourceId: "bob:active-reminders",
              sourceLabel: "Bob active reminders"
            }
          ],
          conflict: "none",
          model: "test-model",
          durationMs: 10,
          inputTokens: 10,
          outputTokens: 5,
          toolCalls: 1
        },
        {
          ...request,
          userText: "List my reminders.",
          contextItems: [],
          allowedTools: ["reminder_list"]
        }
      )
    ).toEqual({
      text: "You have no active reminders.\nSource: Bob active reminders",
      reasonCode: "agent_reply"
    })
  })

  it("rejects completed personal recall without an approved source", () => {
    const groundedRequest = {
      ...request,
      userText: "When do I train?",
      contextItems: [
        {
          kind: "fact" as const,
          text: "Training day is Tuesday.",
          instruction: false as const,
          conflict: false,
          sources: [{ sourceId: "fact-1", sourceLabel: "Owner message linked on 11 Aug 2026" }]
        }
      ]
    }

    expect(
      selectAgentResponse(
        {
          protocolVersion: 1,
          runId: request.runId,
          correlationId: request.correlationId,
          status: "completed",
          responseText: "Your training day is Tuesday.",
          sourceIds: [],
          conflict: "none",
          model: "test-model",
          durationMs: 10,
          inputTokens: 10,
          outputTokens: 5,
          toolCalls: 0
        },
        groundedRequest
      )
    ).toEqual({
      text: "I do not have a supported record for that.",
      reasonCode: "agent_boundary_fallback"
    })
  })

  it("requires grounding for personal recall in an earlier turn message", () => {
    const targetMessageId = "00000000-0000-4000-8000-000000000004"

    expect(
      selectAgentResponse(
        {
          protocolVersion: 1,
          runId: request.runId,
          correlationId: request.correlationId,
          status: "completed",
          responseText: "You train on Tuesdays.",
          sourceIds: [],
          conflict: "none",
          model: "test-model",
          durationMs: 10,
          inputTokens: 10,
          outputTokens: 5,
          toolCalls: 0
        },
        {
          ...request,
          sourceMessageId: targetMessageId,
          userText: "List",
          currentTurnMessages: [
            {
              sourceMessageId: "00000000-0000-4000-8000-000000000005",
              text: "What is my training routine?"
            },
            { sourceMessageId: targetMessageId, text: "List" }
          ],
          allowedTools: ["memory_search"]
        }
      )
    ).toEqual({
      text: "I do not have a supported record for that.",
      reasonCode: "agent_boundary_fallback"
    })
  })

  it("allows an uncited greeting despite loaded personal context", () => {
    const groundedRequest = {
      ...request,
      userText: "Hello Bob",
      contextItems: [
        {
          kind: "fact" as const,
          text: "Training day is Tuesday.",
          instruction: false as const,
          conflict: false,
          sources: [{ sourceId: "fact-1", sourceLabel: "Owner message linked on 11 Aug 2026" }]
        }
      ]
    }

    expect(
      selectAgentResponse(
        {
          protocolVersion: 1,
          runId: request.runId,
          correlationId: request.correlationId,
          status: "completed",
          responseText: "Hello. How can I help?",
          sourceIds: [],
          conflict: "none",
          model: "test-model",
          durationMs: 10,
          inputTokens: 10,
          outputTokens: 5,
          toolCalls: 0
        },
        groundedRequest
      )
    ).toEqual({ text: "Hello. How can I help?", reasonCode: "agent_reply" })
  })

  it("accepts a safe no-Tool reply from the rollout-compatible agent contract", () => {
    expect(
      selectAgentResponse(
        {
          protocolVersion: 1,
          runId: request.runId,
          correlationId: request.correlationId,
          status: "completed",
          responseText: "Hello. How can I help?",
          model: "test-model",
          durationMs: 10,
          inputTokens: 10,
          outputTokens: 5,
          toolCalls: 0
        },
        {
          ...request,
          userText: "Hello Bob",
          allowedTools: []
        }
      )
    ).toEqual({
      text: "Hello. How can I help?",
      reasonCode: "agent_boundary_fallback"
    })
  })

  it("does not trust a legacy completed reply after a Tool call", () => {
    expect(
      selectAgentResponse(
        {
          protocolVersion: 1,
          runId: request.runId,
          correlationId: request.correlationId,
          status: "completed",
          responseText: "Your reminder is active.",
          model: "test-model",
          durationMs: 10,
          inputTokens: 10,
          outputTokens: 5,
          toolCalls: 1
        },
        {
          ...request,
          userText: "Create a reminder for tomorrow at 09:00."
        }
      )
    ).toEqual({
      text: "I could not complete that request. Please try again in Bob.",
      reasonCode: "agent_failure"
    })
  })

  it("allows an uncited action response despite loaded personal context", () => {
    const groundedRequest = {
      ...request,
      userText: "Create a reminder for tomorrow at 09:00.",
      contextItems: [
        {
          kind: "fact" as const,
          text: "Training day is Tuesday.",
          instruction: false as const,
          conflict: false,
          sources: [{ sourceId: "fact-1", sourceLabel: "Owner message linked on 11 Aug 2026" }]
        }
      ]
    }

    expect(
      selectAgentResponse(
        {
          protocolVersion: 1,
          runId: request.runId,
          correlationId: request.correlationId,
          status: "completed",
          responseText: "Your reminder is active.",
          sourceIds: [],
          conflict: "none",
          model: "test-model",
          durationMs: 10,
          inputTokens: 10,
          outputTokens: 5,
          toolCalls: 1
        },
        groundedRequest
      )
    ).toEqual({ text: "Your reminder is active.", reasonCode: "agent_reply" })
  })

  it("rejects unknown source IDs at the core boundary", () => {
    expect(
      selectAgentResponse(
        {
          protocolVersion: 1,
          runId: request.runId,
          correlationId: request.correlationId,
          status: "completed",
          responseText: "Your training day is Tuesday.",
          sourceIds: ["unknown"],
          conflict: "none",
          model: "test-model",
          durationMs: 10,
          inputTokens: 10,
          outputTokens: 5,
          toolCalls: 0
        },
        request
      )
    ).toEqual({
      text: "I could not complete that request. Please try again in Bob.",
      reasonCode: "agent_failure"
    })
  })

  it("keeps a safe deterministic tool result after model output fails", () => {
    expect(
      selectAgentResponse(
        {
          protocolVersion: 1,
          runId: request.runId,
          correlationId: request.correlationId,
          status: "failed",
          responseText:
            "I could not finish the assistant response. Reminder set for 2026-08-12 09:00 Europe/Stockholm.",
          errorCode: "invalid_output",
          model: "test-model",
          durationMs: 10,
          inputTokens: 10,
          outputTokens: 5,
          toolCalls: 1
        },
        request
      )
    ).toEqual({
      text: "I could not finish the assistant response. Reminder set for 2026-08-12 09:00 Europe/Stockholm.",
      reasonCode: "agent_boundary_fallback"
    })
  })

  it("replaces a secret-like boundary fallback", () => {
    expect(
      selectAgentResponse(
        {
          protocolVersion: 1,
          runId: request.runId,
          correlationId: request.correlationId,
          status: "failed",
          responseText: "The token is sk-proj-abcdefghijklmnopqrstuvwxyz012345.",
          errorCode: "invalid_output",
          model: "test-model",
          durationMs: 10,
          inputTokens: 10,
          outputTokens: 5,
          toolCalls: 0
        },
        request
      )
    ).toEqual({
      text: "I could not complete that request. Please try again in Bob.",
      reasonCode: "agent_failure"
    })
  })
})
