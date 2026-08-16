import { captureEvents } from "@bob/observability/testing"
import { afterEach, describe, expect, it, vi } from "vitest"

import type { CoreBindings } from "../src/bindings.ts"
import type { CoreComposition } from "../src/composition.ts"

import { processConversationTurn } from "../src/process-inbound.ts"
import { conversationTurnFixture, testFixture } from "./test-fixture.ts"

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("core model failure fallback", () => {
  it("uses approved context without another tool action", async () => {
    const eventId = "018e6f65-4d55-7a1b-8df4-4ee15ea1db90"
    const ownerId = "018e6f65-4d55-7a1b-8df4-4ee15ea1db91"
    const channelId = "018e6f65-4d55-7a1b-8df4-4ee15ea1db92"
    const messageId = "018e6f65-4d55-7a1b-8df4-4ee15ea1db93"
    const correlationId = "018e6f65-4d55-7a1b-8df4-4ee15ea1db94"
    const turnId = "018e6f65-4d55-7a1b-8df4-4ee15ea1db89"
    const attemptId = "018e6f65-4d55-7a1b-8df4-4ee15ea1db96"
    const completeWithResponse = vi.fn(async () => "018e6f65-4d55-7a1b-8df4-4ee15ea1db95")
    const toolExecute = vi.fn()
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 500 }))
    )
    // SAFETY: This controlled test fixture matches the asserted contract used by this test.
    const composition = testFixture<CoreComposition>({
      config: {
        AGENT_URL: "https://agent.example.invalid",
        AGENT_CALLER_SECRET: "secret",
        BOB_MODEL: "test-model",
        BOB_RUN_TOKEN_BUDGET: 32_000,
        BOB_DAILY_TOKEN_BUDGET: 250_000
      },
      database: {},
      services: {
        events: captureEvents(),
        conversations: { claimReaction: vi.fn(async () => false) },
        turns: {
          markRunning: vi.fn(async () => true),
          currentRevision: vi.fn(async () => 1),
          commitReply: vi.fn(async () => "committed" as const),
          markEventsProcessed: vi.fn(async () => 1)
        },
        training: { stopActiveForSafety: vi.fn() },
        journal: { createHandoff: vi.fn() },
        reminders: { applyBoundReply: vi.fn() },
        settings: {
          get: vi.fn(async () => ({
            timeZone: "Europe/Stockholm",
            locale: "en",
            hourCycle: "h23"
          }))
        },
        context: {
          build: vi.fn(async () => [
            {
              kind: "training" as const,
              text: "Routine Full Body A: 1. Leg press (3 sets × 10 reps).",
              instruction: false as const,
              conflict: false,
              sources: [
                {
                  sourceId: "routine-current",
                  sourceLabel: "routine 2026-08-09"
                }
              ]
            }
          ])
        },
        runs: {
          loadForTurn: vi.fn(async () => undefined),
          create: vi.fn(async (request: { runId: string }) => ({
            runId: request.runId,
            duplicate: false
          })),
          claim: vi.fn(async () => attemptId),
          releaseForRetry: vi.fn(async () => ({ status: "exhausted" as const })),
          completeWithResponse
        },
        tools: { execute: toolExecute },
        alerts: { record: vi.fn() },
        delivery: { markEnqueued: vi.fn() }
      }
    })
    // SAFETY: This controlled test fixture matches the asserted contract used by this test.
    const bindings = testFixture<CoreBindings>({
      OUTBOUND_QUEUE: { send: vi.fn(async () => undefined) }
    })

    await processConversationTurn(
      conversationTurnFixture({
        eventId,
        ownerId,
        channelId,
        messageId,
        text: "What is my training routine?",
        correlationId,
        turnId
      }),
      bindings,
      composition
    )

    expect(completeWithResponse).toHaveBeenCalledWith(
      expect.objectContaining({ status: "failed", errorCode: "provider", toolCalls: 0 }),
      {
        channelId,
        text: "I could not use the assistant. From your saved records: Routine Full Body A: 1. Leg press (3 sets × 10 reps).",
        reasonCode: "agent_degraded_recall"
      },
      { conversationTurnId: turnId, conversationTurnRevision: 1 },
      attemptId
    )
    expect(toolExecute).not.toHaveBeenCalled()
  })
})
