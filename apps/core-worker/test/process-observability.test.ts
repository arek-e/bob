import { withBobSpan } from "@bob/observability/effect"
import {
  externalParentFromTraceparent,
  formatTraceparent,
  parseTraceparent
} from "@bob/observability/propagation"
import { captureEvents, makeCaptureTelemetry } from "@bob/observability/testing"
import { Effect } from "effect"
import { afterEach, describe, expect, it, vi } from "vitest"

import type { CoreBindings } from "../src/bindings.ts"
import type { CoreComposition } from "../src/composition.ts"

import { processInbound } from "../src/process-inbound.ts"

const eventId = "018e6f65-4d55-7a1b-8df4-4ee15ea1db90"
const ownerId = "018e6f65-4d55-7a1b-8df4-4ee15ea1db91"
const channelId = "018e6f65-4d55-7a1b-8df4-4ee15ea1db92"
const messageId = "018e6f65-4d55-7a1b-8df4-4ee15ea1db93"
const correlationId = "018e6f65-4d55-7a1b-8df4-4ee15ea1db94"
const outboxId = "018e6f65-4d55-7a1b-8df4-4ee15ea1db95"
const inboundTraceId = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
const inboundParentSpanId = "1111111111111111"
const inboundTraceparent = `00-${inboundTraceId}-${inboundParentSpanId}-01`

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("core workflow telemetry", () => {
  it("keeps one safe trace through inbound processing and outbox publish", async () => {
    const events = captureEvents()
    const telemetry = makeCaptureTelemetry({
      serviceName: "bob-core",
      serviceVersion: "0123456789abcdef0123456789abcdef01234567",
      deploymentEnvironment: "test"
    })
    const telemetryRunner = {
      runPromise: <A, E>(effect: Effect.Effect<A, E>) =>
        Effect.runPromise(effect.pipe(Effect.provide(telemetry.layer)))
    }
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
    const composition = {
      config: {
        AGENT_URL: "https://agent.example.invalid",
        AGENT_ACCESS_CLIENT_ID: "client",
        AGENT_ACCESS_CLIENT_SECRET: "secret",
        BOB_MODEL: "gpt-test",
        BOB_RUN_TOKEN_BUDGET: 32_000,
        BOB_DAILY_TOKEN_BUDGET: 250_000
      },
      database: {},
      services: {
        events,
        conversations: {
          claimInbound: vi.fn(async () => ({
            eventId,
            ownerId,
            channelId,
            messageId,
            text: privateUserText,
            correlationId
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
        context: { build: contextBuild },
        runs: {
          loadForInbound: vi.fn(async () => undefined),
          create: vi.fn(async (request: { runId: string }) => ({
            runId: request.runId,
            duplicate: false
          })),
          claim: vi.fn(async () => true),
          completeWithResponse: vi.fn(async () => outboxId)
        },
        alerts: { record: vi.fn() },
        delivery: { markEnqueued: vi.fn(async () => undefined) }
      }
    } as unknown as CoreComposition
    const bindings = {
      OUTBOUND_QUEUE: {
        send: async (job: unknown) => {
          sent.push(job)
        }
      }
    } as unknown as CoreBindings

    const inboundParent = externalParentFromTraceparent(inboundTraceparent)
    if (inboundParent === undefined) throw new Error("Test traceparent is invalid")
    const processTraceparent = await telemetryRunner.runPromise(
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
    await processInbound(
      eventId,
      bindings,
      composition,
      processTraceparent,
      telemetryRunner,
      correlationId
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
        correlationId,
        traceparent: expect.stringMatching(new RegExp(`^00-${inboundTraceId}-[0-9a-f]{16}-01$`))
      }
    ])
    expect(composition.services.runs.completeWithResponse).toHaveBeenCalledWith(
      expect.objectContaining({ sourceIds: [messageId], conflict: "none" }),
      {
        channelId,
        text: `${privateResponse}\nSource: message 2026-08-11`,
        reasonCode: "agent_reply"
      }
    )

    const spans = telemetry.finishedSpans()
    const consume = spans.find((span) => span.name === "bob.inbound.consume")
    const process = spans.find((span) => span.name === "bob.inbound.process")
    const claim = spans.find((span) => span.name === "bob.inbound.claim")
    const context = spans.find((span) => span.name === "bob.context.build")
    const retrieve = spans.find((span) => span.name === "bob.context.retrieve")
    const invoke = spans.find((span) => span.name === "bob.agent.invoke")
    const create = spans.find((span) => span.name === "bob.outbox.create")
    const publish = spans.find((span) => span.name === "bob.outbox.publish")
    expect(consume?.parentSpanId).toBe(inboundParentSpanId)
    expect(process?.parentSpanId).toBe(consume?.spanId)
    expect(claim?.parentSpanId).toBe(process?.spanId)
    expect(context?.parentSpanId).toBe(process?.spanId)
    expect(retrieve?.parentSpanId).toBe(context?.spanId)
    expect(invoke?.parentSpanId).toBe(process?.spanId)
    expect(create?.parentSpanId).toBe(process?.spanId)
    expect(publish?.parentSpanId).toBe(create?.spanId)
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
    expect(events.events).toContainEqual(
      expect.objectContaining({
        type: "retrieval",
        strategy: "fts",
        selectedCount: 1,
        sourceCount: 1
      })
    )
    const serialized = JSON.stringify(spans, (_key, value) =>
      typeof value === "bigint" ? value.toString() : value
    )
    for (const canary of [privateContext, privateUserText, privateResponse]) {
      expect(serialized).not.toContain(canary)
    }
  })
})
