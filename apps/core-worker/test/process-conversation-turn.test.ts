import { makeCaptureTelemetry } from "@bob/observability/testing"
import { Effect } from "effect"
import { afterEach, describe, expect, it, vi } from "vitest"

import type { CoreBindings } from "../src/bindings.ts"
import type { CoreComposition } from "../src/composition.ts"
import type { ConversationTurnSnapshot } from "../src/modules/conversations/turn-store.ts"

import { processConversationTurn } from "../src/process-inbound.ts"

const ownerId = "018e6f65-4d55-7a1b-8df4-4ee15ea1db91"
const channelId = "018e6f65-4d55-7a1b-8df4-4ee15ea1db92"
const firstEventId = "018e6f65-4d55-7a1b-8df4-4ee15ea1db93"
const firstMessageId = "018e6f65-4d55-7a1b-8df4-4ee15ea1db94"
const latestEventId = "018e6f65-4d55-7a1b-8df4-4ee15ea1db95"
const latestMessageId = "018e6f65-4d55-7a1b-8df4-4ee15ea1db96"
const correlationId = "018e6f65-4d55-7a1b-8df4-4ee15ea1db97"
const turnId = "018e6f65-4d55-7a1b-8df4-4ee15ea1db98"
const outboxId = "018e6f65-4d55-7a1b-8df4-4ee15ea1db99"
const attemptId = "018e6f65-4d55-7a1b-8df4-4ee15ea1db9a"
const claimExpiresAt = "2026-08-12T10:01:30.000Z"

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe("conversation turn processing", () => {
  it("commits a deterministic reply through the current turn revision", async () => {
    const sent: unknown[] = []
    const createOutbox = vi.fn(async () => outboxId)
    const markRunning = vi.fn(async (_turnId: string, _revision: number, _runId: string) => true)
    const commitReply = vi.fn(async () => "committed" as const)
    const markEventsProcessed = vi.fn(async () => 1)
    const composition = {
      config: {},
      services: {
        events: { emit: vi.fn(async () => undefined) },
        conversations: { claimReaction: vi.fn(async () => false) },
        turns: {
          markRunning,
          currentRevision: vi.fn(async () => 1),
          commitReply,
          markEventsProcessed
        },
        training: { stopActiveForSafety: vi.fn() },
        journal: { createHandoff: vi.fn() },
        reminders: { applyBoundReply: vi.fn() },
        delivery: {
          createOutbox,
          markEnqueued: vi.fn(async () => undefined)
        }
      }
    } as unknown as CoreComposition
    const snapshot: ConversationTurnSnapshot = {
      turnId,
      ownerId,
      channelId,
      revision: 1,
      claimExpiresAt,
      latest: {
        eventId: latestEventId,
        messageId: latestMessageId,
        text: "HELP",
        ordinal: 1,
        providerMessageHandle: "provider-latest",
        service: "imessage",
        isGroup: false,
        correlationId,
        number: "+46700000000",
        fromNumber: "+46711111111"
      },
      messages: [
        {
          eventId: latestEventId,
          messageId: latestMessageId,
          text: "HELP",
          ordinal: 1
        }
      ]
    }

    await processConversationTurn(
      snapshot,
      {
        OUTBOUND_QUEUE: {
          send: async (job: unknown) => {
            sent.push(job)
          }
        }
      } as unknown as CoreBindings,
      composition
    )

    expect(markRunning).toHaveBeenCalledWith(turnId, 1, expect.any(String))
    const deterministicRunId = markRunning.mock.calls[0]?.[2]
    expect(createOutbox).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationTurnId: turnId,
        conversationTurnRevision: 1,
        replyToMessageHandle: "provider-latest"
      })
    )
    expect(commitReply).toHaveBeenCalledWith(turnId, 1, deterministicRunId, outboxId)
    expect(markEventsProcessed).toHaveBeenCalledWith(turnId, 1)
    expect(sent).toHaveLength(1)
  })

  it("rechecks the turn revision before a deterministic side effect", async () => {
    const stopActiveForSafety = vi.fn(async () => undefined)
    const createOutbox = vi.fn(async () => outboxId)
    const releaseSettling = vi.fn(async () => ({ ready: false }))
    const markRunning = vi.fn(async () => true)
    const currentRevision = vi.fn(async () => 2)
    const composition = {
      config: {},
      services: {
        events: { emit: vi.fn(async () => undefined) },
        conversations: { claimReaction: vi.fn(async () => false) },
        turns: {
          markRunning,
          currentRevision,
          releaseSettling,
          commitReply: vi.fn(),
          markEventsProcessed: vi.fn()
        },
        training: { stopActiveForSafety },
        journal: { createHandoff: vi.fn() },
        reminders: { applyBoundReply: vi.fn() },
        delivery: { createOutbox, markEnqueued: vi.fn(async () => undefined) }
      }
    } as unknown as CoreComposition
    const snapshot: ConversationTurnSnapshot = {
      turnId,
      ownerId,
      channelId,
      revision: 1,
      claimExpiresAt,
      latest: {
        eventId: latestEventId,
        messageId: latestMessageId,
        text: "My knee hurts after that set",
        ordinal: 1,
        providerMessageHandle: "provider-latest",
        service: "sms",
        isGroup: false,
        correlationId,
        number: "+46700000000",
        fromNumber: "+46711111111"
      },
      messages: [
        {
          eventId: latestEventId,
          messageId: latestMessageId,
          text: "My knee hurts after that set",
          ordinal: 1
        }
      ]
    }

    await processConversationTurn(
      snapshot,
      { OUTBOUND_QUEUE: { send: vi.fn() } } as unknown as CoreBindings,
      composition
    )

    expect(markRunning).toHaveBeenCalledOnce()
    expect(currentRevision).toHaveBeenCalledOnce()
    expect(currentRevision.mock.invocationCallOrder[0]).toBeGreaterThan(
      markRunning.mock.invocationCallOrder[0]!
    )
    expect(stopActiveForSafety).not.toHaveBeenCalled()
    expect(createOutbox).not.toHaveBeenCalled()
    expect(releaseSettling).toHaveBeenCalledWith(turnId, latestEventId)
  })

  it("runs one immutable request for the newest revision and publishes one reply", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
    const telemetry = makeCaptureTelemetry({
      serviceName: "bob-core-worker",
      serviceVersion: "0123456789abcdef0123456789abcdef01234567",
      deploymentEnvironment: "test"
    })
    const reflectTraceId = "dddddddddddddddddddddddddddddddd"
    const collectSpanId = "5555555555555555"
    const sent: unknown[] = []
    const markRunning = vi.fn(async () => true)
    const commitReply = vi.fn(async () => "committed" as const)
    const markEventsProcessed = vi.fn(async () => 2)
    const completeWithResponse = vi.fn(async () => outboxId)
    const buildContext = vi.fn(async () => [])
    let resolveAgentResponse!: (response: Response) => void
    const agentResponse = new Promise<Response>((resolve) => {
      resolveAgentResponse = resolve
    })
    let capturedRequest: Record<string, unknown> | undefined
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        capturedRequest = JSON.parse(String(init?.body)) as Record<string, unknown>
        return agentResponse
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
        events: { emit: vi.fn(async () => undefined) },
        conversations: { claimReaction: vi.fn(async () => false) },
        turns: {
          markRunning,
          currentRevision: vi.fn(async () => 2),
          commitReply,
          markEventsProcessed
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
        context: { build: buildContext },
        runs: {
          loadForInbound: vi.fn(async () => undefined),
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
    } as unknown as CoreComposition
    const bindings = {
      OUTBOUND_QUEUE: {
        send: async (job: unknown) => {
          sent.push(job)
        }
      }
    } as unknown as CoreBindings
    const snapshot: ConversationTurnSnapshot = {
      turnId,
      ownerId,
      channelId,
      revision: 2,
      claimExpiresAt,
      latest: {
        eventId: latestEventId,
        messageId: latestMessageId,
        text: "List",
        ordinal: 2,
        providerMessageHandle: "provider-latest",
        service: "sms",
        isGroup: false,
        correlationId,
        traceparent: `00-${reflectTraceId}-${collectSpanId}-01`,
        number: "+46700000000",
        fromNumber: "+46711111111"
      },
      messages: [
        {
          eventId: firstEventId,
          messageId: firstMessageId,
          text: "Lost my reminders",
          ordinal: 1
        },
        {
          eventId: latestEventId,
          messageId: latestMessageId,
          text: "List",
          ordinal: 2
        }
      ]
    }

    const processing = processConversationTurn(snapshot, bindings, composition, {
      runPromise: (effect) => Effect.runPromise(effect.pipe(Effect.provide(telemetry.layer)))
    })
    await vi.waitFor(() => expect(capturedRequest).toBeDefined())
    await vi.advanceTimersByTimeAsync(125_000)
    resolveAgentResponse(
      Response.json({
        protocolVersion: 1,
        runId: capturedRequest!.runId,
        correlationId,
        status: "completed",
        responseText: "You have no active reminders.",
        sourceIds: [],
        conflict: "none",
        model: "gpt-test",
        durationMs: 125_000,
        inputTokens: 10,
        outputTokens: 5,
        toolCalls: 1
      })
    )
    await processing

    expect(capturedRequest).toMatchObject({
      conversationTurnId: turnId,
      conversationTurnRevision: 2,
      sourceMessageId: latestMessageId,
      userText: "List",
      currentTurnMessages: [
        { sourceMessageId: firstMessageId, text: "Lost my reminders" },
        { sourceMessageId: latestMessageId, text: "List" }
      ],
      allowedTools: expect.arrayContaining(["reminder_list"])
    })
    expect(buildContext).toHaveBeenCalledWith(
      expect.objectContaining({ currentUserText: "Lost my reminders\nList" })
    )
    expect(markRunning).toHaveBeenCalledWith(turnId, 2, capturedRequest?.runId)
    expect(composition.services.runs.claim).toHaveBeenCalledWith(capturedRequest?.runId, 140_000)
    expect(completeWithResponse).toHaveBeenCalledWith(
      expect.objectContaining({ status: "completed" }),
      expect.objectContaining({
        channelId,
        text: "You have no active reminders.",
        reasonCode: "agent_reply"
      }),
      { conversationTurnId: turnId, conversationTurnRevision: 2 },
      attemptId
    )
    expect(commitReply).toHaveBeenCalledWith(turnId, 2, capturedRequest?.runId, outboxId)
    expect(markEventsProcessed).toHaveBeenCalledWith(turnId, 2)
    expect(sent).toHaveLength(1)
    const reflect = telemetry.finishedSpans().find((span) => span.name === "bob.turn.reflect")
    const process = telemetry.finishedSpans().find((span) => span.name === "bob.inbound.process")
    expect(reflect).toMatchObject({
      traceId: reflectTraceId,
      parentSpanId: collectSpanId,
      attributes: expect.objectContaining({
        "bob.correlation.id": correlationId,
        "bob.conversation.turn_id": turnId,
        "bob.conversation.revision": 2
      })
    })
    expect(process?.parentSpanId).toBe(reflect?.spanId)
  })

  it("suppresses a stale attempt before it reaches the agent host", async () => {
    const invoke = vi.fn()
    vi.stubGlobal("fetch", invoke)
    const completeWithoutResponse = vi.fn(async () => true)
    const releaseSettling = vi.fn(async () => ({ ready: false }))
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
        events: { emit: vi.fn(async () => undefined) },
        conversations: { claimReaction: vi.fn(async () => false) },
        turns: {
          markRunning: vi.fn(async () => true),
          currentRevision: vi.fn(async () => 3),
          releaseSettling,
          commitReply: vi.fn(),
          markEventsProcessed: vi.fn()
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
        context: { build: vi.fn(async () => []) },
        runs: {
          loadForInbound: vi.fn(async () => undefined),
          create: vi.fn(async (request: { runId: string }) => ({
            runId: request.runId,
            duplicate: false
          })),
          claim: vi.fn(async () => attemptId),
          completeWithoutResponse,
          completeWithResponse: vi.fn()
        },
        alerts: { record: vi.fn() },
        delivery: { markEnqueued: vi.fn(async () => undefined) }
      }
    } as unknown as CoreComposition
    const snapshot: ConversationTurnSnapshot = {
      turnId,
      ownerId,
      channelId,
      revision: 2,
      claimExpiresAt,
      latest: {
        eventId: latestEventId,
        messageId: latestMessageId,
        text: "List",
        ordinal: 2,
        providerMessageHandle: "provider-latest",
        service: "sms",
        isGroup: false,
        correlationId,
        number: "+46700000000",
        fromNumber: "+46711111111"
      },
      messages: [
        {
          eventId: firstEventId,
          messageId: firstMessageId,
          text: "Lost my reminders",
          ordinal: 1
        },
        {
          eventId: latestEventId,
          messageId: latestMessageId,
          text: "List",
          ordinal: 2
        }
      ]
    }

    await processConversationTurn(
      snapshot,
      { OUTBOUND_QUEUE: { send: vi.fn() } } as unknown as CoreBindings,
      composition
    )

    expect(invoke).not.toHaveBeenCalled()
    expect(completeWithoutResponse).toHaveBeenCalledWith(
      expect.objectContaining({ status: "cancelled", errorCode: "cancelled" }),
      attemptId
    )
    expect(releaseSettling).toHaveBeenCalledWith(turnId, expect.any(String))
  })

  it("registers reminder_list for a new short follow-up after a delivered reminder turn", async () => {
    let capturedRequest: Record<string, unknown> | undefined
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        capturedRequest = JSON.parse(String(init?.body)) as Record<string, unknown>
        return Response.json({
          protocolVersion: 1,
          runId: capturedRequest.runId,
          correlationId,
          status: "completed",
          responseText: "You have no active reminders.",
          sourceIds: [],
          conflict: "none",
          model: "gpt-test",
          durationMs: 20,
          inputTokens: 10,
          outputTokens: 5,
          toolCalls: 1
        })
      })
    )
    const recentToolCapabilities = vi.fn(async () => ["reminder_list"] as const)
    const build = vi.fn(async () => [
      {
        kind: "conversation" as const,
        text: "Owner: Lost my reminders\nBob: You have no active reminders.",
        instruction: false as const,
        conflict: false,
        sources: []
      }
    ])
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
        events: { emit: vi.fn(async () => undefined) },
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
        context: { build, recentToolCapabilities },
        runs: {
          loadForInbound: vi.fn(async () => undefined),
          create: vi.fn(async (request: { runId: string }) => ({
            runId: request.runId,
            duplicate: false
          })),
          claim: vi.fn(async () => attemptId),
          completeWithResponse: vi.fn(async () => outboxId)
        },
        alerts: { record: vi.fn() },
        delivery: { markEnqueued: vi.fn(async () => undefined) }
      }
    } as unknown as CoreComposition
    const snapshot: ConversationTurnSnapshot = {
      turnId,
      ownerId,
      channelId,
      revision: 1,
      claimExpiresAt,
      latest: {
        eventId: latestEventId,
        messageId: latestMessageId,
        text: "List",
        ordinal: 1,
        providerMessageHandle: "provider-latest",
        service: "sms",
        isGroup: false,
        correlationId,
        number: "+46700000000",
        fromNumber: "+46711111111"
      },
      messages: [
        {
          eventId: latestEventId,
          messageId: latestMessageId,
          text: "List",
          ordinal: 1
        }
      ]
    }

    await processConversationTurn(
      snapshot,
      { OUTBOUND_QUEUE: { send: vi.fn(async () => undefined) } } as unknown as CoreBindings,
      composition
    )

    expect(recentToolCapabilities).toHaveBeenCalledWith(
      expect.objectContaining({
        ownerId,
        channelId,
        currentConversationTurnId: turnId,
        currentUserText: "List"
      })
    )
    expect(capturedRequest).toMatchObject({
      userText: "List",
      currentTurnMessages: [{ sourceMessageId: latestMessageId, text: "List" }],
      allowedTools: expect.arrayContaining(["reminder_list"])
    })
  })

  it("does not release a settling turn when a replacement attempt owns the run", async () => {
    const completeWithoutResponse = vi.fn(async () => false)
    const completeWithResponse = vi.fn(async () => outboxId)
    const publish = vi.fn(async () => undefined)
    const releaseSettling = vi.fn(async () => ({ ready: true }))
    const currentRevision = vi.fn(async () => 3)
    currentRevision.mockResolvedValueOnce(2)
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        const request = JSON.parse(String(init?.body)) as { runId: string }
        return Response.json({
          protocolVersion: 1,
          runId: request.runId,
          correlationId,
          status: "cancelled",
          errorCode: "cancelled",
          model: "gpt-test",
          durationMs: 10,
          inputTokens: 2,
          outputTokens: 0,
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
        events: { emit: vi.fn(async () => undefined) },
        conversations: { claimReaction: vi.fn(async () => false) },
        turns: {
          markRunning: vi.fn(async () => true),
          currentRevision,
          releaseSettling,
          commitReply: vi.fn(),
          markEventsProcessed: vi.fn()
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
        context: { build: vi.fn(async () => []) },
        runs: {
          loadForInbound: vi.fn(async () => undefined),
          create: vi.fn(async (request: { runId: string }) => ({
            runId: request.runId,
            duplicate: false
          })),
          claim: vi.fn(async () => attemptId),
          completeWithoutResponse,
          completeWithResponse
        },
        alerts: { record: vi.fn() },
        delivery: { markEnqueued: vi.fn(async () => undefined) }
      }
    } as unknown as CoreComposition
    const snapshot = {
      turnId,
      ownerId,
      channelId,
      revision: 2,
      claimExpiresAt,
      latest: {
        eventId: latestEventId,
        messageId: latestMessageId,
        text: "List",
        ordinal: 2,
        providerMessageHandle: "provider-latest",
        service: "sms" as const,
        isGroup: false,
        correlationId,
        number: "+46700000000",
        fromNumber: "+46711111111"
      },
      messages: [
        {
          eventId: firstEventId,
          messageId: firstMessageId,
          text: "Lost my reminders",
          ordinal: 1
        },
        {
          eventId: latestEventId,
          messageId: latestMessageId,
          text: "List",
          ordinal: 2
        }
      ]
    }

    await processConversationTurn(
      snapshot,
      { OUTBOUND_QUEUE: { send: publish } } as unknown as CoreBindings,
      composition
    )

    expect(completeWithoutResponse).toHaveBeenCalledWith(
      expect.objectContaining({ status: "cancelled" }),
      attemptId
    )
    expect(completeWithResponse).not.toHaveBeenCalled()
    expect(releaseSettling).not.toHaveBeenCalled()
    expect(publish).not.toHaveBeenCalled()
  })

  it("releases a settling turn only after the active run returns", async () => {
    const releaseSettling = vi.fn(async () => ({ ready: true, quietUntil: "2026-08-12T10:00:03Z" }))
    const currentRevision = vi.fn(async () => 3)
    currentRevision.mockResolvedValueOnce(2)
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        const request = JSON.parse(String(init?.body)) as { runId: string }
        return Response.json({
          protocolVersion: 1,
          runId: request.runId,
          correlationId,
          status: "cancelled",
          errorCode: "cancelled",
          model: "gpt-test",
          durationMs: 10,
          inputTokens: 2,
          outputTokens: 0,
          toolCalls: 1
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
        events: { emit: vi.fn(async () => undefined) },
        conversations: { claimReaction: vi.fn(async () => false) },
        turns: {
          markRunning: vi.fn(async () => true),
          currentRevision,
          releaseSettling,
          commitReply: vi.fn(),
          markEventsProcessed: vi.fn()
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
        context: { build: vi.fn(async () => []) },
        runs: {
          loadForInbound: vi.fn(async () => undefined),
          create: vi.fn(async (request: { runId: string }) => ({
            runId: request.runId,
            duplicate: false
          })),
          claim: vi.fn(async () => attemptId),
          completeWithoutResponse: vi.fn(async () => true),
          completeWithResponse: vi.fn()
        },
        alerts: { record: vi.fn() },
        delivery: { markEnqueued: vi.fn(async () => undefined) }
      }
    } as unknown as CoreComposition
    const snapshot = {
      turnId,
      ownerId,
      channelId,
      revision: 2,
      claimExpiresAt,
      latest: {
        eventId: latestEventId,
        messageId: latestMessageId,
        text: "List",
        ordinal: 2,
        providerMessageHandle: "provider-latest",
        service: "sms" as const,
        isGroup: false,
        correlationId,
        number: "+46700000000",
        fromNumber: "+46711111111"
      },
      messages: [
        {
          eventId: firstEventId,
          messageId: firstMessageId,
          text: "Lost my reminders",
          ordinal: 1
        },
        {
          eventId: latestEventId,
          messageId: latestMessageId,
          text: "List",
          ordinal: 2
        }
      ]
    }

    const wake = vi.fn(async () => new Response(null, { status: 200 }))
    const jurisdiction = {
      idFromName: vi.fn(() => ({ toString: () => ownerId })),
      get: vi.fn(() => ({ fetch: wake }))
    }
    await processConversationTurn(
      snapshot,
      {
        OWNER_RUN_COORDINATOR: { jurisdiction: vi.fn(() => jurisdiction) }
      } as unknown as CoreBindings,
      composition
    )

    expect(releaseSettling).toHaveBeenCalledWith(turnId, expect.any(String))
    expect(wake).toHaveBeenCalledWith("https://coordinator.internal/wake", { method: "POST" })
  })

  it("resumes an exact terminal turn only through its revision-fenced outbox", async () => {
    const commitReply = vi.fn(async () => "committed" as const)
    const markEventsProcessed = vi.fn(async () => 2)
    const markEnqueued = vi.fn(async () => undefined)
    const existingOutboxId = "018e6f65-4d55-7a1b-8df4-4ee15ea1db80"
    const publish = vi.fn(async () => undefined)
    const runId = "018e6f65-4d55-7a1b-8df4-4ee15ea1db81"
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
        events: { emit: vi.fn(async () => undefined) },
        conversations: { claimReaction: vi.fn(async () => false) },
        turns: {
          markRunning: vi.fn(async () => true),
          currentRevision: vi.fn(async () => 2),
          commitReply,
          markEventsProcessed
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
        context: { build: vi.fn(async () => []) },
        runs: {
          loadForInbound: vi.fn(async () => ({
            request: {
              protocolVersion: 1,
              runId,
              ownerId,
              correlationId,
              conversationTurnId: turnId,
              conversationTurnRevision: 2,
              sourceMessageId: latestMessageId,
              localTime: "2026-08-12T10:00:00.000Z",
              timeZone: "Europe/Stockholm",
              userText: "List",
              currentTurnMessages: [
                { sourceMessageId: firstMessageId, text: "Lost my reminders" },
                { sourceMessageId: latestMessageId, text: "List" }
              ],
              contextItems: [],
              allowedTools: ["reminder_list"],
              limits: {
                maxTurns: 4,
                maxToolCalls: 4,
                maxDurationMs: 60_000,
                maxResponseCharacters: 1_200
              }
            },
            status: "completed" as const,
            outboxId: existingOutboxId
          })),
          create: vi.fn(),
          claim: vi.fn(),
          completeWithResponse: vi.fn()
        },
        alerts: { record: vi.fn() },
        delivery: { markEnqueued }
      }
    } as unknown as CoreComposition
    const snapshot: ConversationTurnSnapshot = {
      turnId,
      ownerId,
      channelId,
      revision: 2,
      claimExpiresAt,
      latest: {
        eventId: latestEventId,
        messageId: latestMessageId,
        text: "List",
        ordinal: 2,
        providerMessageHandle: "provider-latest",
        service: "sms",
        isGroup: false,
        correlationId,
        number: "+46700000000",
        fromNumber: "+46711111111"
      },
      messages: [
        { eventId: firstEventId, messageId: firstMessageId, text: "Lost my reminders", ordinal: 1 },
        { eventId: latestEventId, messageId: latestMessageId, text: "List", ordinal: 2 }
      ]
    }

    await processConversationTurn(
      snapshot,
      { OUTBOUND_QUEUE: { send: publish } } as unknown as CoreBindings,
      composition
    )

    expect(commitReply).toHaveBeenCalledWith(turnId, 2, runId, existingOutboxId)
    expect(markEventsProcessed).toHaveBeenCalledWith(turnId, 2)
    expect(markEnqueued).toHaveBeenCalledWith(existingOutboxId, expect.any(String))
    expect(publish).toHaveBeenCalledOnce()
    expect(composition.services.runs.claim).not.toHaveBeenCalled()
    expect(composition.services.runs.completeWithResponse).not.toHaveBeenCalled()
  })

  it("does not create an unfenced reply for a superseded terminal run", async () => {
    const publish = vi.fn(async () => undefined)
    const claim = vi.fn(async () => true)
    const completeWithResponse = vi.fn()
    const runId = "018e6f65-4d55-7a1b-8df4-4ee15ea1db82"
    const composition = {
      config: { BOB_MODEL: "gpt-test" },
      services: {
        events: { emit: vi.fn(async () => undefined) },
        conversations: { claimReaction: vi.fn(async () => false) },
        turns: { markRunning: vi.fn(async () => true) },
        training: { stopActiveForSafety: vi.fn() },
        journal: { createHandoff: vi.fn() },
        reminders: { applyBoundReply: vi.fn() },
        runs: {
          loadForInbound: vi.fn(async () => ({
            request: {
              protocolVersion: 1,
              runId,
              ownerId,
              correlationId,
              conversationTurnId: turnId,
              conversationTurnRevision: 2,
              sourceMessageId: latestMessageId,
              localTime: "2026-08-12T10:00:00.000Z",
              timeZone: "Europe/Stockholm",
              userText: "List",
              currentTurnMessages: [
                { sourceMessageId: firstMessageId, text: "Lost my reminders" },
                { sourceMessageId: latestMessageId, text: "List" }
              ],
              contextItems: [],
              allowedTools: ["reminder_list"],
              limits: {
                maxTurns: 4,
                maxToolCalls: 4,
                maxDurationMs: 60_000,
                maxResponseCharacters: 1_200
              }
            },
            status: "superseded" as const
          })),
          create: vi.fn(),
          claim,
          completeWithResponse
        }
      }
    } as unknown as CoreComposition
    const snapshot: ConversationTurnSnapshot = {
      turnId,
      ownerId,
      channelId,
      revision: 2,
      claimExpiresAt,
      latest: {
        eventId: latestEventId,
        messageId: latestMessageId,
        text: "List",
        ordinal: 2,
        providerMessageHandle: "provider-latest",
        service: "sms",
        isGroup: false,
        correlationId,
        number: "+46700000000",
        fromNumber: "+46711111111"
      },
      messages: [
        { eventId: firstEventId, messageId: firstMessageId, text: "Lost my reminders", ordinal: 1 },
        { eventId: latestEventId, messageId: latestMessageId, text: "List", ordinal: 2 }
      ]
    }

    await processConversationTurn(
      snapshot,
      { OUTBOUND_QUEUE: { send: publish } } as unknown as CoreBindings,
      composition
    )

    expect(claim).not.toHaveBeenCalled()
    expect(completeWithResponse).not.toHaveBeenCalled()
    expect(publish).not.toHaveBeenCalled()
  })
})
