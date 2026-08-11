import { captureEvents } from "@bob/observability/testing"
import { parseTraceparent } from "@bob/observability/trace"
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
  it("propagates one trace through context, model, and outbox spans", async () => {
    const events = captureEvents()
    const sent: unknown[] = []
    const contextItem = {
      kind: "fact" as const,
      text: "Stored private fact",
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
        return Response.json(
          {
            protocolVersion: 1,
            runId: body.runId,
            correlationId,
            status: "completed",
            responseText: "Safe response",
            sourceIds: [messageId],
            conflict: "none",
            model: "test-model",
            durationMs: 20,
            inputTokens: 10,
            outputTokens: 5,
            toolCalls: 0
          },
          { headers: { traceparent: headers.get("traceparent")! } }
        )
      })
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
        events,
        conversations: {
          claimInbound: vi.fn(async () => ({
            eventId,
            ownerId,
            channelId,
            messageId,
            text: "What is my saved note?",
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
        delivery: { markEnqueued: vi.fn() }
      }
    } as unknown as CoreComposition
    const bindings = {
      OUTBOUND_QUEUE: {
        send: async (job: unknown) => {
          sent.push(job)
        }
      }
    } as unknown as CoreBindings

    await processInbound(eventId, bindings, composition, inboundTraceparent)

    expect(contextBuild).toHaveBeenCalledWith(
      expect.objectContaining({
        ownerId,
        channelId,
        currentMessageId: messageId,
        currentUserText: "What is my saved note?",
        timeZone: "Europe/Stockholm"
      })
    )
    expect(sent).toEqual([
      {
        outboxId,
        traceparent: expect.stringMatching(new RegExp(`^00-${inboundTraceId}-[0-9a-f]{16}-01$`))
      }
    ])
    expect(composition.services.runs.completeWithResponse).toHaveBeenCalledWith(
      expect.objectContaining({ sourceIds: [messageId], conflict: "none" }),
      {
        channelId,
        text: "Safe response\nSource: message 2026-08-11",
        reasonCode: "agent_reply"
      }
    )
    expect(events.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "workflow_span", name: "context.build" }),
        expect.objectContaining({
          type: "retrieval",
          strategy: "fts",
          selectedCount: 1,
          sourceCount: 1
        }),
        expect.objectContaining({ type: "workflow_span", name: "model.run" }),
        expect.objectContaining({ type: "workflow_span", name: "outbox.create" }),
        expect.objectContaining({ type: "workflow_span", name: "outbox.publish" })
      ])
    )
    const traceIds = events.events.flatMap((event) =>
      event.type === "workflow_span" ? [event.traceId] : []
    )
    expect(new Set(traceIds)).toEqual(new Set([inboundTraceId]))
    expect(events.events).toContainEqual(
      expect.objectContaining({
        type: "workflow_span",
        name: "context.build",
        parentSpanId: inboundParentSpanId
      })
    )
    expect(JSON.stringify(events.events)).not.toContain("Stored private fact")
    expect(JSON.stringify(events.events)).not.toContain("What is my saved note?")
  })
})
