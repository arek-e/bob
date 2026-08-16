import type { ConversationTurnSnapshot } from "@bob/core-service/conversations/turn-store"
import type { CoreBindings } from "@bob/core-types/bindings"
import type { OutboundJob } from "@bob/core-types/jobs"

import { AgentRunRequest } from "@bob/core-types/agent"
import { transitionalDeploymentProfile } from "@bob/core-types/profiles"
import { makeCaptureTelemetry } from "@bob/observability/testing"
import { Effect, Schema } from "effect"
import { afterEach, describe, expect, it, vi } from "vitest"

import type { CoreComposition } from "../src/composition.ts"

import { processConversationTurn } from "../src/process-inbound.ts"
import { testFixture } from "./test-fixture.ts"

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
    // SAFETY: This controlled test fixture matches the asserted contract used by this test.
    const composition = testFixture<CoreComposition>({
      config: { CHANNEL_EGRESS_URL: "" },
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
    })
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
      // SAFETY: This controlled test fixture matches the asserted contract used by this test.
      testFixture<CoreBindings>({
        OUTBOUND_QUEUE: {
          send: async (job: OutboundJob) => {
            sent.push(job)
          }
        }
      }),
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
    // SAFETY: This controlled test fixture matches the asserted contract used by this test.
    const composition = testFixture<CoreComposition>({
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
    })
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
      // SAFETY: This focused test double implements every platform member exercised by this test.
      testFixture<CoreBindings>({ OUTBOUND_QUEUE: { send: vi.fn() } }),
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
      serviceName: "bob-core-runtime",
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
    const priorToolReceipts = vi.fn(async () => [
      {
        origin: "same_turn" as const,
        toolName: "reminder_create" as const,
        actionOutcome: "confirmed" as const
      }
    ])
    let resolveAgentResponse!: (response: Response) => void
    const agentResponse = new Promise<Response>((resolve) => {
      resolveAgentResponse = resolve
    })
    let capturedRequest: AgentRunRequest | undefined
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        // SAFETY: This controlled test fixture matches the asserted contract used by this test.
        capturedRequest = Schema.decodeUnknownSync(AgentRunRequest)(JSON.parse(String(init?.body)))
        return agentResponse
      })
    )
    // SAFETY: This controlled test fixture matches the asserted contract used by this test.
    const composition = testFixture<CoreComposition>({
      config: {
        AGENT_URL: "https://agent.example.invalid",
        AGENT_CALLER_SECRET: "secret",
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
        context: { build: buildContext, priorToolReceipts },
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
    // SAFETY: This controlled test fixture matches the asserted contract used by this test.
    const bindings = testFixture<CoreBindings>({
      OUTBOUND_QUEUE: {
        send: async (job: OutboundJob) => {
          sent.push(job)
        }
      }
    })
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
      allowedTools: expect.arrayContaining(["reminder_list"]),
      priorToolReceipts: [
        {
          origin: "same_turn",
          toolName: "reminder_create",
          actionOutcome: "confirmed"
        }
      ]
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
    expect(
      telemetry
        .finishedSpans()
        .flatMap((span) => span.events)
        .some(
          (event) =>
            event.name === "bob.decision.steering" &&
            event.attributes["bob.decision.code"] === "restart_with_receipts" &&
            event.attributes["bob.decision.outcome"] === "applied" &&
            event.attributes["bob.selected.count"] === 1 &&
            event.attributes["bob.conversation.revision"] === 2
        )
    ).toBe(true)
  })

  it("releases a transient Agent failure for checkpoint replay", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 503 }))
    )
    const releaseForRetry = vi.fn(async () => ({
      status: "released" as const,
      wakeAt: "2026-08-12T10:00:00.000Z"
    }))
    const completeWithResponse = vi.fn()
    const wake = vi.fn(async () => undefined)
    // SAFETY: This focused test double implements every platform member exercised by this test.
    const composition = testFixture<CoreComposition>({
      config: {
        AGENT_URL: "https://agent.example.invalid",
        AGENT_CALLER_SECRET: "secret",
        BOB_MODEL: "gpt-test",
        BOB_RUN_TOKEN_BUDGET: 32_000,
        BOB_DAILY_TOKEN_BUDGET: 250_000
      },
      database: {},
      runCoordinator: { wake },
      services: {
        events: { emit: vi.fn(async () => undefined) },
        conversations: { claimReaction: vi.fn(async () => false) },
        turns: {
          markRunning: vi.fn(async () => true),
          currentRevision: vi.fn(async () => 2)
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
          loadForTurn: vi.fn(async () => undefined),
          create: vi.fn(async (request: { runId: string }) => ({
            runId: request.runId,
            duplicate: false
          })),
          claim: vi.fn(async () => attemptId),
          releaseForRetry,
          completeWithResponse
        },
        alerts: { record: vi.fn(async () => undefined) }
      }
    })
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
      // SAFETY: This focused test double implements every platform member exercised by this test.
      testFixture<CoreBindings>({}),
      composition
    )

    expect(releaseForRetry).toHaveBeenCalledWith(
      expect.objectContaining({ status: "failed", errorCode: "provider" }),
      attemptId,
      3,
      30_000,
      { conversationTurnId: turnId, conversationTurnRevision: 2 }
    )
    expect(wake).toHaveBeenCalledWith({
      ownerId,
      wakeAt: "2026-08-12T10:00:00.000Z"
    })
    expect(completeWithResponse).not.toHaveBeenCalled()
  })

  it("suppresses a transient Agent failure after the turn revision changes", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 503 }))
    )
    const currentRevision = vi
      .fn<() => Promise<number | undefined>>()
      .mockResolvedValueOnce(2)
      .mockResolvedValue(3)
    const releaseForRetry = vi.fn()
    const completeWithoutResponse = vi.fn(async () => true)
    const releaseSettling = vi.fn(async () => ({ ready: false }))
    const composition = testFixture<CoreComposition>({
      config: {
        AGENT_URL: "https://agent.example.invalid",
        AGENT_CALLER_SECRET: "secret",
        BOB_MODEL: "gpt-test"
      },
      database: {},
      services: {
        events: { emit: vi.fn(async () => undefined) },
        conversations: { claimReaction: vi.fn(async () => false) },
        turns: {
          markRunning: vi.fn(async () => true),
          currentRevision,
          releaseSettling
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
        tools: { mutationActivity: vi.fn(async () => ({ status: "none" as const })) },
        runs: {
          loadForTurn: vi.fn(async () => undefined),
          create: vi.fn(async (request: { runId: string }) => ({
            runId: request.runId,
            duplicate: false
          })),
          claim: vi.fn(async () => attemptId),
          releaseForRetry,
          completeWithoutResponse
        },
        alerts: { record: vi.fn(async () => undefined) }
      }
    })
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

    await processConversationTurn(snapshot, testFixture<CoreBindings>({}), composition)

    expect(currentRevision).toHaveBeenCalledTimes(2)
    expect(releaseForRetry).not.toHaveBeenCalled()
    expect(completeWithoutResponse).toHaveBeenCalledWith(
      expect.objectContaining({ status: "failed", errorCode: "provider" }),
      attemptId
    )
    expect(releaseSettling).toHaveBeenCalledWith(turnId, expect.any(String))
  })

  it("suppresses a stale attempt before it reaches the agent host", async () => {
    const invoke = vi.fn()
    vi.stubGlobal("fetch", invoke)
    const completeWithoutResponse = vi.fn(async () => true)
    const releaseSettling = vi.fn(async () => ({ ready: false }))
    // SAFETY: This controlled test fixture matches the asserted contract used by this test.
    const composition = testFixture<CoreComposition>({
      config: {
        AGENT_URL: "https://agent.example.invalid",
        AGENT_CALLER_SECRET: "secret",
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
          loadForTurn: vi.fn(async () => undefined),
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
    })
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
      // SAFETY: This focused test double implements every platform member exercised by this test.
      testFixture<CoreBindings>({ OUTBOUND_QUEUE: { send: vi.fn() } }),
      composition
    )

    expect(invoke).not.toHaveBeenCalled()
    expect(completeWithoutResponse).toHaveBeenCalledWith(
      expect.objectContaining({ status: "cancelled", errorCode: "cancelled" }),
      attemptId
    )
    expect(releaseSettling).toHaveBeenCalledWith(turnId, expect.any(String))
  })

  it("registers every reviewed capability for a short follow-up", async () => {
    let capturedRequest: AgentRunRequest | undefined
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        // SAFETY: This controlled test fixture matches the asserted contract used by this test.
        capturedRequest = Schema.decodeUnknownSync(AgentRunRequest)(JSON.parse(String(init?.body)))
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
    const build = vi.fn(async () => [
      {
        kind: "conversation" as const,
        text: "Owner: Lost my reminders\nBob: You have no active reminders.",
        instruction: false as const,
        conflict: false,
        sources: []
      }
    ])
    // SAFETY: This controlled test fixture matches the asserted contract used by this test.
    const composition = testFixture<CoreComposition>({
      config: {
        AGENT_URL: "https://agent.example.invalid",
        AGENT_CALLER_SECRET: "secret",
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
        context: { build },
        runs: {
          loadForTurn: vi.fn(async () => undefined),
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
    })
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
      // SAFETY: This focused test double implements every platform member exercised by this test.
      testFixture<CoreBindings>({ OUTBOUND_QUEUE: { send: vi.fn(async () => undefined) } }),
      composition
    )

    expect(capturedRequest).toMatchObject({
      userText: "List",
      currentTurnMessages: [{ sourceMessageId: latestMessageId, text: "List" }],
      allowedTools: transitionalDeploymentProfile.modelToolNames,
      deploymentProfileId: transitionalDeploymentProfile.profileId,
      capabilityCatalogueGeneration: transitionalDeploymentProfile.generation
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
        // SAFETY: This controlled test fixture matches the asserted contract used by this test.
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
    // SAFETY: This controlled test fixture matches the asserted contract used by this test.
    const composition = testFixture<CoreComposition>({
      config: {
        AGENT_URL: "https://agent.example.invalid",
        AGENT_CALLER_SECRET: "secret",
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
          loadForTurn: vi.fn(async () => undefined),
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
    })
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
      // SAFETY: This focused test double implements every platform member exercised by this test.
      testFixture<CoreBindings>({ OUTBOUND_QUEUE: { send: publish } }),
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
    const wake = vi.fn(async () => undefined)
    currentRevision.mockResolvedValueOnce(2)
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        // SAFETY: This controlled test fixture matches the asserted contract used by this test.
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
    // SAFETY: This controlled test fixture matches the asserted contract used by this test.
    const composition = testFixture<CoreComposition>({
      config: {
        AGENT_URL: "https://agent.example.invalid",
        AGENT_CALLER_SECRET: "secret",
        BOB_MODEL: "gpt-test",
        BOB_RUN_TOKEN_BUDGET: 32_000,
        BOB_DAILY_TOKEN_BUDGET: 250_000
      },
      database: {},
      ownerRunCoordinator: { wake },
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
          loadForTurn: vi.fn(async () => undefined),
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
    })
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
      // SAFETY: This controlled test fixture matches the asserted contract used by this test.
      testFixture<CoreBindings>({}),
      composition
    )

    expect(releaseSettling).toHaveBeenCalledWith(turnId, expect.any(String))
    expect(wake).toHaveBeenCalledWith({ ownerId })
  })

  it.each([
    {
      label: "active mutation",
      activity: {
        status: "active" as const,
        retryAt: "2026-08-12T10:01:00.000Z",
        recoveryRequired: false,
        recoveryExhausted: false,
        originRevision: 2
      },
      transition: {
        status: "settling" as const,
        revision: 3,
        wakeAt: "2026-08-12T10:01:00.000Z"
      },
      afterTransition: undefined,
      releasesAfterTransition: false,
      expectedSettleUntil: "2026-08-12T10:01:00.000Z",
      receiptBacked: false,
      createsReflection: true
    },
    {
      label: "mutation that settles during the transition",
      activity: {
        status: "active" as const,
        retryAt: "2026-08-12T10:01:00.000Z",
        recoveryRequired: false,
        recoveryExhausted: false,
        originRevision: 2
      },
      transition: {
        status: "settling" as const,
        revision: 3,
        wakeAt: "2026-08-12T10:01:00.000Z"
      },
      afterTransition: { status: "completed" as const, completedInRun: true },
      releasesAfterTransition: true,
      expectedSettleUntil: "2026-08-12T10:01:00.000Z",
      receiptBacked: false,
      createsReflection: true
    },
    {
      label: "expired mutation that completes during recovery",
      activity: {
        status: "active" as const,
        retryAt: "2026-08-12T10:01:00.000Z",
        recoveryRequired: true,
        recoveryExhausted: false,
        originRevision: 1
      },
      transition: {
        status: "released" as const,
        revision: 3,
        wakeAt: "2026-08-12T10:00:03.000Z"
      },
      afterTransition: { status: "completed" as const, completedInRun: false },
      releasesAfterTransition: false,
      expectedSettleUntil: undefined,
      receiptBacked: false,
      createsReflection: true
    },
    {
      label: "completed mutation",
      activity: {
        status: "completed" as const,
        completedInRun: true
      },
      transition: {
        status: "released" as const,
        revision: 3,
        wakeAt: "2026-08-12T10:00:03.000Z"
      },
      afterTransition: undefined,
      releasesAfterTransition: false,
      expectedSettleUntil: undefined,
      receiptBacked: false,
      createsReflection: true
    },
    {
      label: "receipt-backed failed run without a third revision",
      activity: {
        status: "completed" as const,
        completedInRun: true
      },
      transition: {
        status: "released" as const,
        revision: 3,
        wakeAt: "2026-08-12T10:00:03.000Z"
      },
      afterTransition: undefined,
      releasesAfterTransition: false,
      expectedSettleUntil: undefined,
      receiptBacked: true,
      createsReflection: false
    }
  ])(
    "handles an $label after a mutation outlives the agent result",
    async ({
      activity,
      transition,
      afterTransition,
      releasesAfterTransition,
      expectedSettleUntil,
      receiptBacked,
      createsReflection
    }) => {
      const completeWithResponse = vi.fn(async () => outboxId)
      const completeWithoutResponse = vi.fn()
      const completeForReflection = vi.fn(async () => transition)
      const releaseSettling = vi.fn(async () => ({ ready: true }))
      const currentRevision = vi.fn<() => Promise<number>>().mockResolvedValue(2)
      const commitReply = vi.fn(async () => "committed" as const)
      const markEventsProcessed = vi.fn(async () => 1)
      const publish = vi.fn(async () => undefined)
      const wake = vi.fn(async () => undefined)
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response(null, { status: 500 }))
      )
      const mutationActivity = vi
        .fn()
        .mockResolvedValueOnce(activity)
        .mockResolvedValue(afterTransition ?? activity)
      // SAFETY: This controlled test fixture matches the asserted contract used by this test.
      const composition = testFixture<CoreComposition>({
        config: {
          AGENT_URL: "https://agent.example.invalid",
          AGENT_CALLER_SECRET: "secret",
          BOB_MODEL: "gpt-test",
          BOB_RUN_TOKEN_BUDGET: 32_000,
          BOB_DAILY_TOKEN_BUDGET: 250_000
        },
        database: {},
        ownerRunCoordinator: { wake },
        services: {
          events: { emit: vi.fn(async () => undefined) },
          conversations: { claimReaction: vi.fn(async () => false) },
          turns: {
            markRunning: vi.fn(async () => true),
            currentRevision,
            releaseSettling,
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
          context: {
            build: vi.fn(async () => []),
            priorToolReceipts: vi.fn(async () =>
              receiptBacked
                ? [
                    {
                      origin: "same_turn" as const,
                      toolName: "reminder_create" as const,
                      result: { ok: true as const, code: "reminder_created" as const }
                    }
                  ]
                : []
            )
          },
          runs: {
            loadForTurn: vi.fn(async () => undefined),
            create: vi.fn(async (request: { runId: string }) => ({
              runId: request.runId,
              duplicate: false
            })),
            claim: vi.fn(async () => attemptId),
            completeWithoutResponse,
            completeForReflection,
            completeWithResponse
          },
          tools: {
            mutationActivity,
            expireMutationRecovery: vi.fn(async () => false)
          },
          alerts: { record: vi.fn(async () => undefined) },
          delivery: { markEnqueued: vi.fn(async () => undefined) }
        }
      })
      const snapshot: ConversationTurnSnapshot = {
        turnId,
        ownerId,
        channelId,
        revision: 2,
        claimExpiresAt,
        latest: {
          eventId: latestEventId,
          messageId: latestMessageId,
          text: "Set my time zone to New York.",
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
            text: "Set my time zone to New York.",
            ordinal: 1
          }
        ]
      }

      await processConversationTurn(
        snapshot,
        // SAFETY: This controlled test fixture matches the asserted contract used by this test.
        testFixture<CoreBindings>({
          OUTBOUND_QUEUE: { send: publish }
        }),
        composition
      )

      expect(composition.services.tools.mutationActivity).toHaveBeenCalledTimes(
        activity.status === "active" ? 2 : 1
      )
      expect(completeWithoutResponse).not.toHaveBeenCalled()
      if (!createsReflection) {
        expect(completeForReflection).not.toHaveBeenCalled()
        expect(completeWithResponse).toHaveBeenCalledWith(
          expect.objectContaining({ status: "failed" }),
          expect.objectContaining({
            text: "I could not complete that request. Please try again in Bob.",
            reasonCode: "agent_failure"
          }),
          { conversationTurnId: turnId, conversationTurnRevision: 2 },
          attemptId
        )
        expect(commitReply).toHaveBeenCalledWith(turnId, 2, expect.any(String), outboxId)
        expect(markEventsProcessed).toHaveBeenCalledWith(turnId, 2)
        expect(publish).toHaveBeenCalledOnce()
        expect(wake).not.toHaveBeenCalled()
        return
      }
      expect(completeWithResponse).not.toHaveBeenCalled()
      expect(releaseSettling).toHaveBeenCalledTimes(releasesAfterTransition ? 1 : 0)
      expect(completeForReflection).toHaveBeenCalledWith(
        expect.objectContaining({ status: "failed" }),
        attemptId,
        expectedSettleUntil === undefined
          ? { conversationTurnId: turnId, conversationTurnRevision: 2 }
          : {
              conversationTurnId: turnId,
              conversationTurnRevision: 2,
              settleUntil: expectedSettleUntil
            }
      )
      expect(wake).toHaveBeenCalledWith(
        releasesAfterTransition ? { ownerId } : { ownerId, wakeAt: transition.wakeAt }
      )
    }
  )

  it.each([
    {
      label: "failed agent result",
      agentResponse: () => new Response(null, { status: 500 })
    },
    {
      label: "completed agent result",
      agentResponse: (request: { runId: string }) =>
        Response.json({
          protocolVersion: 1,
          runId: request.runId,
          correlationId,
          status: "completed",
          responseText: "The reminder was created for 08:00.",
          sourceIds: [],
          conflict: "none",
          model: "gpt-test",
          durationMs: 10,
          inputTokens: 10,
          outputTokens: 5,
          toolCalls: 0
        })
    }
  ])("preserves a terminal unknown result after a $label", async ({ agentResponse }) => {
    const completeForReflection = vi.fn()
    const completeWithResponse = vi.fn(async () => outboxId)
    const expireMutationRecovery = vi.fn(async () => false)
    const mutationActivity = vi
      .fn()
      .mockResolvedValueOnce({
        status: "active" as const,
        retryAt: "2026-08-12T10:01:00.000Z",
        recoveryRequired: true,
        recoveryExhausted: true,
        originRevision: 2
      })
      .mockResolvedValue({ status: "unknown" as const })
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) =>
        // SAFETY: This controlled test fixture matches the asserted contract used by this test.
        agentResponse(JSON.parse(String(init?.body)) as { runId: string })
      )
    )
    // SAFETY: This controlled test fixture matches the asserted contract used by this test.
    const composition = testFixture<CoreComposition>({
      config: {
        AGENT_URL: "https://agent.example.invalid",
        AGENT_CALLER_SECRET: "secret",
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
        context: { build: vi.fn(async () => []) },
        runs: {
          loadForTurn: vi.fn(async () => undefined),
          create: vi.fn(async (request: { runId: string }) => ({
            runId: request.runId,
            duplicate: false
          })),
          claim: vi.fn(async () => attemptId),
          completeForReflection,
          completeWithResponse
        },
        tools: { mutationActivity, expireMutationRecovery },
        alerts: { record: vi.fn(async () => undefined) },
        delivery: { markEnqueued: vi.fn(async () => undefined) }
      }
    })
    const snapshot: ConversationTurnSnapshot = {
      turnId,
      ownerId,
      channelId,
      revision: 2,
      claimExpiresAt,
      latest: {
        eventId: latestEventId,
        messageId: latestMessageId,
        text: "Actually at eight.",
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
          text: "Remind me tomorrow.",
          ordinal: 1
        },
        {
          eventId: latestEventId,
          messageId: latestMessageId,
          text: "Actually at eight.",
          ordinal: 2
        }
      ]
    }
    const publish = vi.fn(async () => undefined)

    await processConversationTurn(
      snapshot,
      // SAFETY: This focused test double implements every platform member exercised by this test.
      testFixture<CoreBindings>({ OUTBOUND_QUEUE: { send: publish } }),
      composition
    )

    expect(expireMutationRecovery).toHaveBeenCalledOnce()
    expect(mutationActivity).toHaveBeenCalledTimes(2)
    expect(completeForReflection).not.toHaveBeenCalled()
    expect(completeWithResponse).toHaveBeenCalledWith(
      expect.objectContaining({ status: "failed", errorCode: "provider" }),
      expect.objectContaining({
        text: "I could not confirm whether that action finished. Review the current state before you try it again."
      }),
      { conversationTurnId: turnId, conversationTurnRevision: 2 },
      attemptId
    )
    expect(publish).toHaveBeenCalledOnce()
  })

  it("resumes an exact terminal turn only through its revision-fenced outbox", async () => {
    const commitReply = vi.fn(async () => "committed" as const)
    const markEventsProcessed = vi.fn(async () => 2)
    const markEnqueued = vi.fn(async () => undefined)
    const existingOutboxId = "018e6f65-4d55-7a1b-8df4-4ee15ea1db80"
    const publish = vi.fn(async () => undefined)
    const runId = "018e6f65-4d55-7a1b-8df4-4ee15ea1db81"
    // SAFETY: This controlled test fixture matches the asserted contract used by this test.
    const composition = testFixture<CoreComposition>({
      config: {
        AGENT_URL: "https://agent.example.invalid",
        AGENT_CALLER_SECRET: "secret",
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
          loadForTurn: vi.fn(async () => ({
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
    })
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
      // SAFETY: This focused test double implements every platform member exercised by this test.
      testFixture<CoreBindings>({ OUTBOUND_QUEUE: { send: publish } }),
      composition
    )

    expect(commitReply).toHaveBeenCalledWith(turnId, 2, runId, existingOutboxId)
    expect(markEventsProcessed).toHaveBeenCalledWith(turnId, 2)
    expect(markEnqueued).toHaveBeenCalledWith(existingOutboxId, expect.any(String), 0)
    expect(publish).toHaveBeenCalledOnce()
    expect(composition.services.runs.claim).not.toHaveBeenCalled()
    expect(composition.services.runs.completeWithResponse).not.toHaveBeenCalled()
  })

  it("does not create an unfenced reply for a superseded terminal run", async () => {
    const publish = vi.fn(async () => undefined)
    const claim = vi.fn(async () => true)
    const completeWithResponse = vi.fn()
    const runId = "018e6f65-4d55-7a1b-8df4-4ee15ea1db82"
    // SAFETY: This controlled test fixture matches the asserted contract used by this test.
    const composition = testFixture<CoreComposition>({
      config: { BOB_MODEL: "gpt-test" },
      services: {
        events: { emit: vi.fn(async () => undefined) },
        conversations: { claimReaction: vi.fn(async () => false) },
        turns: { markRunning: vi.fn(async () => true) },
        training: { stopActiveForSafety: vi.fn() },
        journal: { createHandoff: vi.fn() },
        reminders: { applyBoundReply: vi.fn() },
        runs: {
          loadForTurn: vi.fn(async () => ({
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
    })
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
      // SAFETY: This focused test double implements every platform member exercised by this test.
      testFixture<CoreBindings>({ OUTBOUND_QUEUE: { send: publish } }),
      composition
    )

    expect(claim).not.toHaveBeenCalled()
    expect(completeWithResponse).not.toHaveBeenCalled()
    expect(publish).not.toHaveBeenCalled()
  })
})
