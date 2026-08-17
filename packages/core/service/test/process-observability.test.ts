import type { CoreBindings } from "@bob/core-types/bindings"
import type { OutboundJob } from "@bob/core-types/jobs"

import {
  withBobSpan,
  externalParentFromTraceparent,
  formatTraceparent,
  parseTraceparent,
  makeCaptureTelemetry
} from "@bob/observability"
import { Effect } from "effect"
import { afterEach, describe, expect, it, vi } from "vitest"

import type { CoreComposition } from "../src/composition.ts"

import { processConversationTurnEffect } from "../src/process-inbound.ts"
import { conversationTurnFixture, testFixture } from "./test-fixture.ts"

const eventId = "018e6f65-4d55-7a1b-8df4-4ee15ea1db90"
const ownerId = "018e6f65-4d55-7a1b-8df4-4ee15ea1db91"
const channelId = "018e6f65-4d55-7a1b-8df4-4ee15ea1db92"
const messageId = "018e6f65-4d55-7a1b-8df4-4ee15ea1db93"
const correlationId = "018e6f65-4d55-7a1b-8df4-4ee15ea1db94"
const outboxId = "018e6f65-4d55-7a1b-8df4-4ee15ea1db95"
const attemptId = "018e6f65-4d55-7a1b-8df4-4ee15ea1db99"
const turnId = "018e6f65-4d55-7a1b-8df4-4ee15ea1db89"
const inboundTraceId = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
const inboundParentSpanId = "1111111111111111"
const inboundTraceparent = `00-${inboundTraceId}-${inboundParentSpanId}-01`

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("core workflow telemetry", () => {
  it("keeps one safe trace through inbound processing and outbox publish", async () => {
    const telemetry = makeCaptureTelemetry({
      serviceName: "bob-core-runtime",
      serviceVersion: "0123456789abcdef0123456789abcdef01234567",
      deploymentEnvironment: "test"
    })
    const sent: unknown[] = []
    const privateContext = "private-context-note-8841"
    const privateUserText = "What is my private saved note?"
    const privateResponse = "private-safe-response-5532"
    const contextItem = {
      kind: "fact" as const,
      text: privateContext,
      instruction: false as const,
      conflict: false,
      sources: [{ sourceId: messageId, sourceLabel: "message 2026-08-11" }]
    }
    const contextBuild = vi.fn(async () => [contextItem])
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        const headers = new Headers(init?.headers)
        const trace = parseTraceparent(headers.get("traceparent"))
        expect(trace?.traceId).toBe(inboundTraceId)
        expect(headers.get("x-bob-correlation-id")).toBe(correlationId)
        // SAFETY: This controlled test fixture matches the asserted contract used by this test.
        const body = JSON.parse(String(init?.body)) as { runId: string }
        return Response.json({
          protocolVersion: 1,
          runId: body.runId,
          correlationId,
          status: "completed",
          responseText: privateResponse,
          sourceIds: [messageId],
          conflict: "none",
          model: "gpt-test",
          durationMs: 20,
          inputTokens: 10,
          outputTokens: 5,
          toolCalls: 0
        })
      })
    )
    // SAFETY: This controlled test fixture matches the asserted contract used by this test.
    const completeWithResponse = vi.fn(async () => outboxId)
    const composition = testFixture<CoreComposition>({
      config: {
        AGENT_URL: "https://agent.example.invalid",
        AGENT_CALLER_SECRET: "secret",
        BOB_MODEL: "gpt-test",
        BOB_RUN_TOKEN_BUDGET: 32_000,
        BOB_DAILY_TOKEN_BUDGET: 250_000
      },
      applicationStorage: {},
      services: {
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
        context: { build: contextBuild },
        runs: {
          loadForTurn: vi.fn(async () => undefined),
          create: vi.fn(async (request: { runId: string }) => ({
            runId: request.runId,
            duplicate: false
          })),
          claim: vi.fn(async () => attemptId),
          completeWithResponse
        },
        alerts: { record: vi.fn() },
        delivery: { markEnqueued: vi.fn(async () => undefined) }
      }
    })
    const runTelemetry = <A, E, R>(effect: Effect.Effect<A, E, R>) => {
      const provided = effect.pipe(
        Effect.provide(composition.layer),
        Effect.provide(telemetry.layer)
      )
      // SAFETY: The composition and telemetry Layers provide every service used by this test.
      return Effect.runPromise(provided as Effect.Effect<A, E>)
    }
    // SAFETY: This controlled test fixture matches the asserted contract used by this test.
    const bindings = testFixture<CoreBindings>({
      OUTBOUND_QUEUE: {
        send: async (job: OutboundJob) => {
          sent.push(job)
        }
      }
    })

    const inboundParent = externalParentFromTraceparent(inboundTraceparent)
    if (inboundParent === undefined) throw new Error("Test traceparent is invalid")
    const processTraceparent = await runTelemetry(
      Effect.withParentSpan(
        withBobSpan(
          {
            name: "bob.inbound.consume",
            correlationId,
            feature: "assistant"
          },
          Effect.currentSpan.pipe(Effect.map(formatTraceparent))
        ),
        inboundParent
      )
    )
    await runTelemetry(
      processConversationTurnEffect(
        conversationTurnFixture({
          eventId,
          ownerId,
          channelId,
          messageId,
          text: privateUserText,
          correlationId,
          turnId,
          traceparent: processTraceparent
        }),
        bindings,
        composition
      )
    )

    expect(contextBuild).toHaveBeenCalledWith(
      expect.objectContaining({
        ownerId,
        channelId,
        currentMessageId: messageId,
        currentUserText: privateUserText,
        timeZone: "Europe/Stockholm"
      })
    )
    expect(sent).toEqual([
      {
        outboxId,
        dispatchGeneration: 0,
        correlationId,
        traceparent: expect.stringMatching(new RegExp(`^00-${inboundTraceId}-[0-9a-f]{16}-01$`))
      }
    ])
    expect(completeWithResponse).toHaveBeenCalledWith(
      expect.objectContaining({ sourceIds: [messageId], conflict: "none" }),
      {
        channelId,
        text: privateResponse,
        reasonCode: "agent_reply"
      },
      { conversationTurnId: turnId, conversationTurnRevision: 1 },
      attemptId
    )

    const spans = telemetry.finishedSpans()
    const consume = spans.find((span) => span.name === "bob.inbound.consume")
    const process = spans.find((span) => span.name === "bob.inbound.process")
    const turn = spans.find((span) => span.name === "bob.turn.reflect")
    const context = spans.find((span) => span.name === "bob.context.build")
    const retrieve = spans.find((span) => span.name === "bob.context.retrieve")
    const invoke = spans.find((span) => span.name === "bob.agent.invoke")
    const create = spans.find((span) => span.name === "bob.outbox.create")
    const publish = spans.find((span) => span.name === "bob.outbox.publish")
    expect(consume?.parentSpanId).toBe(inboundParentSpanId)
    expect(turn?.parentSpanId).toBe(consume?.spanId)
    expect(process?.parentSpanId).toBe(turn?.spanId)
    expect(context?.parentSpanId).toBe(process?.spanId)
    expect(retrieve?.parentSpanId).toBe(context?.spanId)
    expect(invoke?.parentSpanId).toBe(process?.spanId)
    expect(create?.parentSpanId).toBe(process?.spanId)
    expect(publish?.parentSpanId).toBe(process?.spanId)
    expect(new Set(spans.map((span) => span.traceId))).toEqual(new Set([inboundTraceId]))
    expect(new Set(spans.map((span) => span.attributes["bob.correlation.id"]))).toEqual(
      new Set([correlationId])
    )
    expect(process?.events).toContainEqual(
      expect.objectContaining({
        name: "bob.decision.route",
        attributes: {
          "bob.decision.code": "agent_turn",
          "bob.decision.outcome": "selected"
        }
      })
    )
    expect(telemetry.healthEvents()).toContainEqual(
      expect.objectContaining({
        type: "retrieval",
        strategy: "fts",
        selectedCount: 1,
        sourceCount: 1
      })
    )
    const serialized = JSON.stringify(spans, (_key, value) =>
      value !== null && value !== undefined && value.constructor === BigInt
        ? value.toString()
        : value
    )
    for (const canary of [privateContext, privateUserText, privateResponse]) {
      expect(serialized).not.toContain(canary)
    }
  })
})
