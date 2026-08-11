import { captureEvents } from "@bob/observability/testing"
import { afterEach, describe, expect, it, vi } from "vitest"

import type { CoreBindings } from "../src/bindings.ts"
import type { CoreComposition } from "../src/composition.ts"

import { processInbound } from "../src/process-inbound.ts"

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("core model failure fallback", () => {
  it("uses approved context without another tool action", async () => {
    const completeWithResponse = vi.fn(async () => "018e6f65-4d55-7a1b-8df4-4ee15ea1db95")
    const toolExecute = vi.fn()
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 500 }))
    )
    const composition = {
      config: {
        AGENT_URL: "https://agent.example.invalid",
        AGENT_ACCESS_CLIENT_ID: "client",
        AGENT_ACCESS_CLIENT_SECRET: "secret",
        BOB_MODEL: "test-model",
        BOB_RUN_TOKEN_BUDGET: 32_000,
        BOB_DAILY_TOKEN_BUDGET: 250_000
      },
      database: {},
      services: {
        events: captureEvents(),
        conversations: {
          claimInbound: vi.fn(async () => ({
            eventId: "018e6f65-4d55-7a1b-8df4-4ee15ea1db90",
            ownerId: "018e6f65-4d55-7a1b-8df4-4ee15ea1db91",
            channelId: "018e6f65-4d55-7a1b-8df4-4ee15ea1db92",
            messageId: "018e6f65-4d55-7a1b-8df4-4ee15ea1db93",
            text: "What is my training routine?",
            correlationId: "018e6f65-4d55-7a1b-8df4-4ee15ea1db94"
          }))
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
          loadForInbound: vi.fn(async () => undefined),
          create: vi.fn(async (request: { runId: string }) => ({
            runId: request.runId,
            duplicate: false
          })),
          claim: vi.fn(async () => true),
          completeWithResponse
        },
        tools: { execute: toolExecute },
        alerts: { record: vi.fn() },
        delivery: { markEnqueued: vi.fn() }
      }
    } as unknown as CoreComposition
    const bindings = {
      OUTBOUND_QUEUE: { send: vi.fn(async () => undefined) }
    } as unknown as CoreBindings

    await processInbound("018e6f65-4d55-7a1b-8df4-4ee15ea1db90", bindings, composition)

    expect(completeWithResponse).toHaveBeenCalledWith(
      expect.objectContaining({ status: "failed", errorCode: "provider", toolCalls: 0 }),
      {
        channelId: "018e6f65-4d55-7a1b-8df4-4ee15ea1db92",
        text: "I could not use the assistant. From your saved records: Routine Full Body A: 1. Leg press (3 sets × 10 reps). [routine 2026-08-09]",
        reasonCode: "agent_degraded_recall"
      }
    )
    expect(toolExecute).not.toHaveBeenCalled()
  })
})
