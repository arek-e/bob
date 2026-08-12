import type { AgentRunRequest } from "@bob/contracts/agent"
import type { ToolCommand, ToolResult } from "@bob/contracts/tools"

import { withBobSpan } from "@bob/observability/effect"
import { makeCaptureTelemetry } from "@bob/observability/testing"
import {
  fauxAssistantMessage,
  fauxToolCall,
  type AssistantMessage,
  type Context
} from "@earendil-works/pi-ai"
import { Effect } from "effect"
import { beforeEach, describe, expect, it, vi } from "vitest"

import { createBobPiAgent } from "../src/index.ts"

const modelHarness = vi.hoisted(() => {
  const state: {
    responses: unknown[]
    contexts: unknown[]
    options: unknown[]
  } = { responses: [], contexts: [], options: [] }

  const completeSimple = vi.fn(
    async (_model: unknown, context: unknown, options: unknown): Promise<unknown> => {
      state.contexts.push(structuredClone(context))
      state.options.push(options)
      const response = state.responses.shift()
      if (typeof response === "function") {
        return await (response as (context: unknown, options: unknown) => unknown)(context, options)
      }
      if (response === undefined) throw new Error("No scripted pi-ai response remains")
      return response
    }
  )

  return {
    completeSimple,
    state,
    model: {
      id: "gpt-test",
      name: "Test model",
      api: "openai-codex-responses",
      provider: "openai-codex",
      reasoning: true,
      input: ["text"],
      contextWindow: 128_000,
      maxTokens: 4_096,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
    },
    reset() {
      state.responses.length = 0
      state.contexts.length = 0
      state.options.length = 0
      completeSimple.mockReset()
      completeSimple.mockImplementation(async (_model, context, options) => {
        state.contexts.push(structuredClone(context))
        state.options.push(options)
        const response = state.responses.shift()
        if (typeof response === "function") {
          return await (response as (context: unknown, options: unknown) => unknown)(
            context,
            options
          )
        }
        if (response === undefined) throw new Error("No scripted pi-ai response remains")
        return response
      })
    }
  }
})

vi.mock("@earendil-works/pi-ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@earendil-works/pi-ai")>()
  return {
    ...actual,
    createModels: () => ({
      setProvider: vi.fn(),
      getModel: vi.fn(() => modelHarness.model),
      completeSimple: modelHarness.completeSimple,
      login: vi.fn()
    })
  }
})

vi.mock("@earendil-works/pi-ai/bun-oauth", () => ({
  registerBunOAuthFlows: vi.fn()
}))

vi.mock("@earendil-works/pi-ai/providers/openai-codex", () => ({
  openaiCodexProvider: vi.fn(() => ({}))
}))

const baseRequest = (overrides: Partial<AgentRunRequest> = {}): AgentRunRequest => ({
  protocolVersion: 1,
  runId: "00000000-0000-4000-8000-000000000001",
  ownerId: "00000000-0000-4000-8000-000000000002",
  correlationId: "00000000-0000-4000-8000-000000000003",
  sourceMessageId: "00000000-0000-4000-8000-000000000004",
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
  },
  ...overrides
})

const jsonResponse = (value: Record<string, unknown>): AssistantMessage =>
  fauxAssistantMessage(JSON.stringify(value), { stopReason: "stop" })

const toolResponse = (...calls: AssistantMessage["content"]): AssistantMessage =>
  fauxAssistantMessage(calls.flat(), { stopReason: "toolUse" })

const structuredResponse = (overrides: Record<string, unknown> = {}) =>
  jsonResponse({
    protocolVersion: 1,
    responseText: "I found the requested record.",
    sourceIds: [],
    toolNames: [],
    conflict: "none",
    ...overrides
  })

const phasedStructuredResponse = (
  commentary: string,
  overrides: Record<string, unknown> = {},
  phaseFinalAnswer = true
): AssistantMessage =>
  fauxAssistantMessage(
    [
      {
        type: "text",
        text: commentary,
        textSignature: JSON.stringify({ v: 1, id: "commentary-1", phase: "commentary" })
      },
      {
        type: "text",
        text: JSON.stringify({
          protocolVersion: 1,
          responseText: "I found the requested record.",
          sourceIds: [],
          toolNames: [],
          conflict: "none",
          ...overrides
        }),
        ...(!phaseFinalAnswer
          ? {}
          : {
              textSignature: JSON.stringify({ v: 1, id: "final-1", phase: "final_answer" })
            })
      }
    ],
    { stopReason: "stop" }
  )

const makeAgent = (
  executeTool: (command: ToolCommand, signal?: AbortSignal) => Promise<ToolResult>,
  now: () => number = () => 1
) =>
  createBobPiAgent({
    credentials: { read: async () => undefined } as never,
    provider: "openai-codex",
    model: "gpt-test",
    allowedModels: ["gpt-test"],
    executeTool,
    now
  })

const okResult = (code = "test", message = "Done."): ToolResult => ({ ok: true, code, message })

describe("Bob's direct pi-ai loop", () => {
  beforeEach(() => {
    modelHarness.reset()
  })

  it("preserves ordered current-turn messages in the model transcript", async () => {
    modelHarness.state.responses.push(
      structuredResponse({ responseText: "You have no active reminders." })
    )
    const agent = makeAgent(async () => okResult())

    await expect(
      agent.runTurn(
        baseRequest({
          sourceMessageId: "00000000-0000-4000-8000-000000000005",
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
          allowedTools: []
        })
      )
    ).resolves.toMatchObject({ status: "completed" })

    const context = modelHarness.state.contexts[0] as Context
    expect(context.messages).toMatchObject([
      { role: "user", content: "I lost my reminders." },
      { role: "user", content: "List them." }
    ])
  })

  it("keeps one opaque mutation identity across revisions of the same conversation turn", async () => {
    const privateLocale = "private-locale-5532"
    modelHarness.state.responses.push(
      toolResponse(
        fauxToolCall(
          "settings_update",
          { locale: privateLocale, hourCycle: "h23" },
          { id: "revision-one-call" }
        )
      ),
      structuredResponse({
        responseText: "Settings updated.",
        toolNames: ["settings_update"]
      }),
      toolResponse(
        fauxToolCall(
          "settings_update",
          { hourCycle: "h23", locale: privateLocale },
          { id: "revision-two-call" }
        )
      ),
      structuredResponse({
        responseText: "Settings updated.",
        toolNames: ["settings_update"]
      })
    )
    const commands: ToolCommand[] = []
    const agent = makeAgent(async (command) => {
      commands.push(command)
      return okResult("owner_settings_updated", "Settings updated.")
    })
    const conversationTurnId = "00000000-0000-4000-8000-000000000010"

    await agent.runTurn(
      baseRequest({
        conversationTurnId,
        conversationTurnRevision: 1,
        userText: "Use my private locale and 24-hour time.",
        allowedTools: ["settings_update"]
      })
    )
    await agent.runTurn(
      baseRequest({
        runId: "00000000-0000-4000-8000-000000000011",
        conversationTurnId,
        conversationTurnRevision: 2,
        userText: "Yes, apply both settings.",
        allowedTools: ["settings_update"]
      })
    )

    expect(commands).toHaveLength(2)
    expect(commands[0]?.idempotencyKey).toMatch(/^turn-mutation:sha256:[0-9a-f]{64}$/)
    expect(commands[1]?.idempotencyKey).toBe(commands[0]?.idempotencyKey)
    expect(commands[0]?.idempotencyKey).not.toContain(privateLocale)
  })

  it("uses per-call identities for read-only tools across conversation turn revisions", async () => {
    modelHarness.state.responses.push(
      toolResponse(fauxToolCall("reminder_list", {}, { id: "revision-one-read" })),
      structuredResponse(),
      toolResponse(fauxToolCall("reminder_list", {}, { id: "revision-two-read" })),
      structuredResponse()
    )
    const commands: ToolCommand[] = []
    const agent = makeAgent(async (command) => {
      commands.push(command)
      return okResult()
    })
    const conversationTurnId = "00000000-0000-4000-8000-000000000010"

    await agent.runTurn(
      baseRequest({
        conversationTurnId,
        conversationTurnRevision: 1,
        allowedTools: ["reminder_list"]
      })
    )
    await agent.runTurn(
      baseRequest({
        runId: "00000000-0000-4000-8000-000000000011",
        conversationTurnId,
        conversationTurnRevision: 2,
        allowedTools: ["reminder_list"]
      })
    )

    expect(commands.map((command) => command.idempotencyKey)).toEqual([
      "00000000-0000-4000-8000-000000000001:revision-one-read",
      "00000000-0000-4000-8000-000000000011:revision-two-read"
    ])
  })

  it("acknowledges a completed prior mutation receipt without redispatch", async () => {
    const receiptSourceId = "00000000-0000-4000-8000-000000000020"
    modelHarness.state.responses.push(
      structuredResponse({
        responseText: "The reminder was created for 08:00.",
        sourceIds: [receiptSourceId]
      })
    )
    const executeTool = vi.fn(async () =>
      okResult("reminder_created", "This mutation must not run again.")
    )
    const agent = makeAgent(executeTool)

    await expect(
      agent.runTurn(
        baseRequest({
          conversationTurnId: "00000000-0000-4000-8000-000000000010",
          conversationTurnRevision: 2,
          sourceMessageId: "00000000-0000-4000-8000-000000000005",
          userText: "Actually, make it eight.",
          currentTurnMessages: [
            {
              sourceMessageId: "00000000-0000-4000-8000-000000000004",
              text: "Remind me at seven."
            },
            {
              sourceMessageId: "00000000-0000-4000-8000-000000000005",
              text: "Actually, make it eight."
            }
          ],
          priorToolReceipts: [
            {
              origin: "same_turn",
              toolName: "reminder_create",
              result: { ok: true, code: "reminder_created" }
            }
          ],
          contextItems: [
            {
              kind: "conversation",
              text: "The owner asked whether the prior action completed.",
              instruction: false,
              conflict: false,
              sources: [
                {
                  sourceId: receiptSourceId,
                  sourceLabel: "Bob action record 2026-08-11",
                  occurredAt: "2026-08-11T10:00:00.000Z"
                }
              ]
            }
          ],
          allowedTools: ["reminder_create"]
        })
      )
    ).resolves.toMatchObject({
      status: "completed",
      responseText: "The reminder was created for 08:00.",
      sourceIds: [receiptSourceId],
      toolCalls: 0
    })
    expect(executeTool).not.toHaveBeenCalled()
    expect(modelHarness.completeSimple).toHaveBeenCalledTimes(1)
    const context = modelHarness.state.contexts[0] as Context
    expect(context.systemPrompt).toContain(
      '[{"origin":"same_turn","toolName":"reminder_create","result":{"ok":true,"code":"reminder_created"}}]'
    )
  })

  it("does not let a predecessor receipt confirm an unrelated current action claim", async () => {
    modelHarness.state.responses.push(
      structuredResponse({ responseText: "The reminder was created for 08:00." }),
      structuredResponse({ responseText: "I am ready to help." })
    )
    const executeTool = vi.fn(async () => okResult())
    const agent = makeAgent(executeTool)

    await expect(
      agent.runTurn(
        baseRequest({
          userText: "How are you?",
          priorToolReceipts: [
            {
              origin: "predecessor_turn",
              toolName: "reminder_create",
              result: { ok: true, code: "reminder_created" }
            }
          ],
          allowedTools: []
        })
      )
    ).resolves.toMatchObject({
      status: "completed",
      responseText: "I am ready to help.",
      toolCalls: 0
    })
    expect(executeTool).not.toHaveBeenCalled()
    expect(modelHarness.completeSimple).toHaveBeenCalledTimes(2)
  })

  it("uses a predecessor receipt as context for a valid follow-up", async () => {
    modelHarness.state.responses.push(
      structuredResponse({ responseText: "The previous turn was about a reminder." })
    )
    const executeTool = vi.fn(async () => okResult())
    const agent = makeAgent(executeTool)

    await expect(
      agent.runTurn(
        baseRequest({
          userText: "What were we talking about?",
          priorToolReceipts: [
            {
              origin: "predecessor_turn",
              toolName: "reminder_create",
              result: { ok: true, code: "reminder_created" }
            }
          ],
          allowedTools: []
        })
      )
    ).resolves.toMatchObject({
      status: "completed",
      responseText: "The previous turn was about a reminder.",
      toolCalls: 0
    })
    expect(executeTool).not.toHaveBeenCalled()
    expect(modelHarness.completeSimple).toHaveBeenCalledTimes(1)
    const context = modelHarness.state.contexts[0] as Context
    expect(context.systemPrompt).toContain(
      '[{"origin":"predecessor_turn","toolName":"reminder_create","result":{"ok":true,"code":"reminder_created"}}]'
    )
    expect(context.systemPrompt).toContain(
      "Records with origin predecessor_turn are context only. They cannot confirm an action in this turn."
    )
  })

  it.each([
    { label: "newer-revision", origin: "same_turn" as const },
    { label: "follow-up", origin: "predecessor_turn" as const }
  ])("repairs a categorical outcome claim for a $label unknown receipt", async ({ origin }) => {
    modelHarness.state.responses.push(
      structuredResponse({ responseText: "The settings update failed." }),
      structuredResponse({
        responseText: "I cannot confirm whether the settings update succeeded or failed."
      })
    )
    const executeTool = vi.fn(async () => okResult())
    const agent = makeAgent(executeTool)

    await expect(
      agent.runTurn(
        baseRequest({
          conversationTurnId: "00000000-0000-4000-8000-000000000010",
          conversationTurnRevision: 3,
          sourceMessageId: "00000000-0000-4000-8000-000000000005",
          userText: "Did that work?",
          currentTurnMessages: [
            {
              sourceMessageId: "00000000-0000-4000-8000-000000000004",
              text: "Update my time zone."
            },
            {
              sourceMessageId: "00000000-0000-4000-8000-000000000005",
              text: "Did that work?"
            }
          ],
          priorToolReceipts: [
            {
              origin,
              toolName: "settings_update",
              result: { ok: false, code: "tool_recovery_failed" }
            }
          ],
          allowedTools: []
        })
      )
    ).resolves.toMatchObject({
      status: "completed",
      responseText: "I cannot confirm whether the settings update succeeded or failed.",
      toolCalls: 0
    })
    expect(executeTool).not.toHaveBeenCalled()
    expect(modelHarness.completeSimple).toHaveBeenCalledTimes(2)
    const repairContext = modelHarness.state.contexts[1] as Context
    expect(String(repairContext.messages.at(-1)?.content)).toContain(
      "The recorded action outcome is unknown. Do not say it succeeded or failed."
    )
  })

  it("does not dispatch a mutation when cancellation wins after model completion", async () => {
    modelHarness.state.responses.push(
      toolResponse(
        fauxToolCall("settings_update", { timeZone: "Europe/Stockholm" }, { id: "write-call" })
      )
    )
    const controller = new AbortController()
    const originalDigest = crypto.subtle.digest.bind(crypto.subtle)
    const digest = vi.spyOn(crypto.subtle, "digest").mockImplementation(async (...arguments_) => {
      const result = await originalDigest(...arguments_)
      controller.abort("newer_turn_revision")
      return result
    })
    let toolCalls = 0
    const agent = makeAgent(async () => {
      toolCalls += 1
      return okResult("owner_settings_updated", "Settings updated.")
    })

    try {
      await expect(
        agent.runTurn(
          baseRequest({
            conversationTurnId: "00000000-0000-4000-8000-000000000010",
            conversationTurnRevision: 1,
            userText: "Use Stockholm time.",
            allowedTools: ["settings_update"]
          }),
          controller.signal
        )
      ).resolves.toMatchObject({ status: "cancelled", errorCode: "cancelled" })
    } finally {
      digest.mockRestore()
    }
    expect(toolCalls).toBe(0)
  })

  it("reports a missing steering target when no run is active", () => {
    const agent = makeAgent(async () => okResult())

    expect(agent.requestSteer(baseRequest().runId)).toEqual({ status: "missing" })
  })

  it("cancels a run that starts after its steering request", async () => {
    vi.useFakeTimers()
    const agent = makeAgent(async () => okResult())
    const request = baseRequest()

    try {
      expect(agent.requestSteer(request.runId)).toEqual({ status: "missing" })
      await vi.advanceTimersByTimeAsync(139_999)
      await expect(agent.runTurn(request)).resolves.toMatchObject({
        status: "cancelled",
        errorCode: "cancelled"
      })
      expect(modelHarness.completeSimple).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it("aborts an active model call when steering is requested", async () => {
    let observedSignal: AbortSignal | undefined
    let markStarted!: () => void
    const started = new Promise<void>((resolve) => {
      markStarted = resolve
    })
    modelHarness.completeSimple.mockImplementation(
      async (_model: unknown, _context: unknown, options: unknown) => {
        observedSignal = (options as { signal?: AbortSignal }).signal
        markStarted()
        return await new Promise<never>(() => undefined)
      }
    )
    const agent = makeAgent(async () => okResult())
    const request = baseRequest({
      limits: { ...baseRequest().limits, maxDurationMs: 500 }
    })
    const run = agent.runTurn(request)

    await started
    expect(agent.requestSteer(request.runId)).toEqual({ status: "aborted_model" })
    const outcome = await Promise.race([
      run.then((result) => ({ type: "result" as const, result })),
      new Promise<{ type: "guard" }>((resolve) => setTimeout(() => resolve({ type: "guard" }), 250))
    ])

    expect(outcome).toMatchObject({
      type: "result",
      result: { status: "cancelled", errorCode: "cancelled" }
    })
    expect(observedSignal?.aborted).toBe(true)
  })

  it("aborts active read-only Tool work when steering is requested", async () => {
    modelHarness.state.responses.push(
      toolResponse(fauxToolCall("reminder_list", {}, { id: "read-call" }))
    )
    let observedSignal: AbortSignal | undefined
    let markStarted!: () => void
    const started = new Promise<void>((resolve) => {
      markStarted = resolve
    })
    const agent = makeAgent(async (_command, signal) => {
      observedSignal = signal
      markStarted()
      return await new Promise<ToolResult>((_resolve, reject) => {
        signal?.addEventListener(
          "abort",
          () => reject(new DOMException("The read was steered.", "AbortError")),
          { once: true }
        )
      })
    })
    const request = baseRequest({
      userText: "List my reminders.",
      allowedTools: ["reminder_list"],
      limits: { ...baseRequest().limits, maxDurationMs: 500 }
    })
    const run = agent.runTurn(request)

    await started
    expect(agent.requestSteer(request.runId)).toEqual({ status: "queued" })
    const outcome = await Promise.race([
      run.then((result) => ({ type: "result" as const, result })),
      new Promise<{ type: "guard" }>((resolve) => setTimeout(() => resolve({ type: "guard" }), 250))
    ])

    expect(outcome).toMatchObject({
      type: "result",
      result: { status: "cancelled", errorCode: "cancelled" }
    })
    expect(observedSignal?.aborted).toBe(true)
  })

  it("queues steering during a Tool call and waits for its result", async () => {
    modelHarness.state.responses.push(
      toolResponse(
        fauxToolCall("settings_update", { timeZone: "Europe/Stockholm" }, { id: "write-call" })
      )
    )
    let markStarted!: () => void
    const started = new Promise<void>((resolve) => {
      markStarted = resolve
    })
    let completeTool!: (result: ToolResult) => void
    const toolResult = new Promise<ToolResult>((resolve) => {
      completeTool = resolve
    })
    const agent = makeAgent(async () => {
      markStarted()
      return toolResult
    })
    const request = baseRequest({
      userText: "Use Stockholm time.",
      allowedTools: ["settings_update"],
      limits: { ...baseRequest().limits, maxDurationMs: 500 }
    })
    const run = agent.runTurn(request)

    await started
    expect(agent.requestSteer(request.runId)).toEqual({ status: "queued" })
    const beforeSettle = await Promise.race([
      run.then(() => "resolved" as const),
      new Promise<"waiting">((resolve) => setTimeout(() => resolve("waiting"), 25))
    ])

    expect(beforeSettle).toBe("waiting")
    completeTool(okResult("settings_updated", "Settings updated."))
    await expect(run).resolves.toMatchObject({ status: "cancelled", errorCode: "cancelled" })
    expect(agent.requestSteer(request.runId)).toEqual({ status: "missing" })
  })

  it("runs one traceable Effect program for a Tool-assisted turn", async () => {
    modelHarness.state.responses.push(
      toolResponse(fauxToolCall("memory_search", { query: "routine" }, { id: "call-1" })),
      structuredResponse({
        responseText: "You prefer morning training.",
        sourceIds: ["fact-revision-1"],
        toolNames: ["memory_search"]
      })
    )
    const telemetry = makeCaptureTelemetry({
      serviceName: "bob-agent",
      serviceVersion: "0123456789abcdef0123456789abcdef01234567",
      deploymentEnvironment: "test"
    })
    const agent = makeAgent(async () => ({
      ok: true,
      code: "memory_results",
      message: "One source found.",
      data: {
        matches: [
          {
            id: "search-document-1",
            sourceId: "fact-revision-1",
            text: "I prefer morning training.",
            sourceLabel: "Owner message"
          }
        ]
      }
    }))

    const request = baseRequest()
    const output = await Effect.runPromise(
      withBobSpan(
        {
          name: "bob.agent.run",
          correlationId: request.correlationId,
          runId: request.runId,
          feature: "memory"
        },
        agent.runTurnEffect(request)
      ).pipe(Effect.provide(telemetry.layer))
    )

    expect(output).toMatchObject({ status: "completed", toolCalls: 1 })
    const spans = telemetry.finishedSpans()
    const runs = spans.filter((span) => span.name === "bob.agent.run")
    const run = runs[0]
    const loop = spans.find((span) => span.name === "bob.agent.loop")
    const turns = spans.filter((span) => span.name === "bob.agent.turn")
    const models = spans.filter((span) => span.name === "bob.model.complete")
    const tool = spans.find((span) => span.name === "bob.tool.invoke")
    const validation = spans.find((span) => span.name === "bob.output.validate")
    expect(runs).toHaveLength(1)
    expect(loop?.parentSpanId).toBe(run?.spanId)
    expect(turns).toHaveLength(2)
    expect(models).toHaveLength(2)
    expect(models.map((span) => span.parentSpanId)).toEqual(turns.map((span) => span.spanId))
    expect(tool?.parentSpanId).toBe(turns[0]?.spanId)
    expect(validation?.parentSpanId).toBe(loop?.spanId)
    expect(loop?.events).toContainEqual(
      expect.objectContaining({
        name: "bob.decision.toolset",
        attributes: {
          "bob.decision.code": "allowed",
          "bob.decision.outcome": "selected",
          "bob.tool.name": "memory_search"
        }
      })
    )
    expect(turns[0]?.events).toContainEqual(
      expect.objectContaining({
        name: "bob.decision.loop",
        attributes: {
          "bob.decision.code": "tool_calls",
          "bob.decision.outcome": "selected",
          "bob.selected.count": 1
        }
      })
    )
  })

  it("records a content-free provider failure inside the model span", async () => {
    const privateCanary = "private-provider-error-+46700000000"
    modelHarness.completeSimple.mockRejectedValue(new Error(privateCanary))
    const telemetry = makeCaptureTelemetry({
      serviceName: "bob-agent",
      serviceVersion: "0123456789abcdef0123456789abcdef01234567",
      deploymentEnvironment: "test"
    })
    const agent = makeAgent(async () => okResult())

    const output = await Effect.runPromise(
      agent.runTurnEffect(baseRequest()).pipe(Effect.provide(telemetry.layer))
    )

    expect(output).toMatchObject({ status: "failed", errorCode: "provider" })
    const modelSpan = telemetry.finishedSpans().find((span) => span.name === "bob.model.complete")
    expect(modelSpan?.outcome).toBe("failed")
    expect(modelSpan?.events).toContainEqual(
      expect.objectContaining({
        name: "bob.decision.loop",
        attributes: {
          "bob.decision.code": "provider_failure",
          "bob.decision.outcome": "denied"
        }
      })
    )
    expect(
      JSON.stringify(telemetry.finishedSpans(), (_key, value) =>
        typeof value === "bigint" ? value.toString() : value
      )
    ).not.toContain(privateCanary)
  })

  it("marks a resolved provider error message as a failed model span", async () => {
    const privateCanary = "private-resolved-provider-error-+46700000001"
    modelHarness.state.responses.push({
      ...fauxAssistantMessage("", { stopReason: "error" }),
      errorMessage: privateCanary
    } satisfies AssistantMessage)
    const telemetry = makeCaptureTelemetry({
      serviceName: "bob-agent",
      serviceVersion: "0123456789abcdef0123456789abcdef01234567",
      deploymentEnvironment: "test"
    })
    const agent = makeAgent(async () => okResult())

    const output = await Effect.runPromise(
      agent
        .runTurnEffect(baseRequest({ userText: "Hello Bob", allowedTools: [] }))
        .pipe(Effect.provide(telemetry.layer))
    )

    expect(output).toMatchObject({ status: "failed", errorCode: "provider" })
    const modelSpan = telemetry.finishedSpans().find((span) => span.name === "bob.model.complete")
    expect(modelSpan?.outcome).toBe("failed")
    expect(modelSpan?.events).toContainEqual(
      expect.objectContaining({
        name: "bob.decision.loop",
        attributes: {
          "bob.decision.code": "provider_failure",
          "bob.decision.outcome": "denied"
        }
      })
    )
    expect(
      JSON.stringify(telemetry.finishedSpans(), (_key, value) =>
        typeof value === "bigint" ? value.toString() : value
      )
    ).not.toContain(privateCanary)
  })

  it("marks a resolved aborted message as a failed model span", async () => {
    const privateCanary = "private-resolved-abort-+46700000002"
    modelHarness.state.responses.push({
      ...fauxAssistantMessage("", { stopReason: "aborted" }),
      errorMessage: privateCanary
    } satisfies AssistantMessage)
    const telemetry = makeCaptureTelemetry({
      serviceName: "bob-agent",
      serviceVersion: "0123456789abcdef0123456789abcdef01234567",
      deploymentEnvironment: "test"
    })
    const agent = makeAgent(async () => okResult())

    const output = await Effect.runPromise(
      agent
        .runTurnEffect(baseRequest({ userText: "Hello Bob", allowedTools: [] }))
        .pipe(Effect.provide(telemetry.layer))
    )

    expect(output).toMatchObject({ status: "cancelled", errorCode: "cancelled" })
    const modelSpan = telemetry.finishedSpans().find((span) => span.name === "bob.model.complete")
    expect(modelSpan?.outcome).toBe("failed")
    expect(modelSpan?.events).toContainEqual(
      expect.objectContaining({
        name: "bob.decision.loop",
        attributes: {
          "bob.decision.code": "timeout",
          "bob.decision.outcome": "applied"
        }
      })
    )
    expect(
      JSON.stringify(telemetry.finishedSpans(), (_key, value) =>
        typeof value === "bigint" ? value.toString() : value
      )
    ).not.toContain(privateCanary)
  })

  it("does not export prompts, Tool data, or assistant content", async () => {
    const privateEarlierUser = "private-earlier-user-message-4410"
    const privateUser = "private-user-routine-8841"
    const privateArgument = "private-tool-argument-5532"
    const privateResult = "private-tool-result-9074"
    const privateAssistant = "private-assistant-output-1168"
    modelHarness.state.responses.push(
      toolResponse(
        fauxToolCall("memory_search", { query: privateArgument }, { id: "safe-tool-call-id" })
      ),
      structuredResponse({
        responseText: privateAssistant,
        sourceIds: ["safe-source-id"],
        toolNames: ["memory_search"]
      })
    )
    const telemetry = makeCaptureTelemetry({
      serviceName: "bob-agent",
      serviceVersion: "0123456789abcdef0123456789abcdef01234567",
      deploymentEnvironment: "test"
    })
    const agent = makeAgent(async () => ({
      ok: true,
      code: "memory_results",
      message: privateResult,
      data: {
        matches: [
          {
            sourceId: "safe-source-id",
            sourceLabel: privateResult,
            text: privateResult
          }
        ]
      }
    }))

    const output = await Effect.runPromise(
      agent
        .runTurnEffect(
          baseRequest({
            sourceMessageId: "00000000-0000-4000-8000-000000000005",
            userText: `What is my routine? ${privateUser}`,
            currentTurnMessages: [
              {
                sourceMessageId: "00000000-0000-4000-8000-000000000004",
                text: privateEarlierUser
              },
              {
                sourceMessageId: "00000000-0000-4000-8000-000000000005",
                text: `What is my routine? ${privateUser}`
              }
            ]
          })
        )
        .pipe(Effect.provide(telemetry.layer))
    )

    expect(output).toMatchObject({ status: "completed", responseText: privateAssistant })
    const serialized = JSON.stringify(telemetry.finishedSpans(), (_key, value) =>
      typeof value === "bigint" ? value.toString() : value
    )
    for (const canary of [
      privateEarlierUser,
      privateUser,
      privateArgument,
      privateResult,
      privateAssistant
    ]) {
      expect(serialized).not.toContain(canary)
    }
  })

  it("runs the Effect Tool adapter inside the active Tool span", async () => {
    modelHarness.state.responses.push(
      toolResponse(fauxToolCall("reminder_list", {}, { id: "call-effect" })),
      structuredResponse({
        responseText: "You have no reminders.",
        toolNames: ["reminder_list"]
      })
    )
    const telemetry = makeCaptureTelemetry({
      serviceName: "bob-agent",
      serviceVersion: "0123456789abcdef0123456789abcdef01234567",
      deploymentEnvironment: "test"
    })
    const fallback = vi.fn(async () => okResult("unexpected"))
    const agent = createBobPiAgent({
      credentials: { read: async () => undefined } as never,
      provider: "openai-codex",
      model: "gpt-test",
      allowedModels: ["gpt-test"],
      executeTool: fallback,
      executeToolEffect: (command) =>
        withBobSpan(
          {
            name: "bob.tool.domain",
            correlationId: baseRequest().correlationId,
            runId: command.runId,
            feature: "reminders",
            toolName: command.name
          },
          Effect.succeed(okResult("reminder_list", "No reminders."))
        ),
      now: () => 1
    })

    const output = await Effect.runPromise(
      agent
        .runTurnEffect(
          baseRequest({
            userText: "Hello Bob",
            allowedTools: ["reminder_list"]
          })
        )
        .pipe(Effect.provide(telemetry.layer))
    )

    expect(output).toMatchObject({ status: "completed", toolCalls: 1 })
    expect(fallback).not.toHaveBeenCalled()
    const spans = telemetry.finishedSpans()
    const invoke = spans.find((span) => span.name === "bob.tool.invoke")
    const domain = spans.find((span) => span.name === "bob.tool.domain")
    expect(domain?.parentSpanId).toBe(invoke?.spanId)
  })

  it("does not let provider Tool call identifiers break telemetry", async () => {
    const providerToolCallId = `call|${"x".repeat(500)}`
    modelHarness.state.responses.push(
      toolResponse(fauxToolCall("reminder_list", {}, { id: providerToolCallId })),
      structuredResponse({
        responseText: "You have no reminders.",
        toolNames: ["reminder_list"]
      })
    )
    const telemetry = makeCaptureTelemetry({
      serviceName: "bob-agent",
      serviceVersion: "0123456789abcdef0123456789abcdef01234567",
      deploymentEnvironment: "test"
    })
    const agent = makeAgent(async () => okResult("reminder_list", "No reminders."))

    const output = await Effect.runPromise(
      agent
        .runTurnEffect(
          baseRequest({
            userText: "Hello Bob",
            allowedTools: ["reminder_list"]
          })
        )
        .pipe(Effect.provide(telemetry.layer))
    )

    expect(output.errorCode).toBeUndefined()
    expect(output).toMatchObject({ status: "completed", toolCalls: 1 })
    expect(telemetry.finishedSpans().some((span) => span.name === "bob.tool.invoke")).toBe(true)
    expect(
      JSON.stringify(telemetry.finishedSpans(), (_key, value) =>
        typeof value === "bigint" ? value.toString() : value
      )
    ).not.toContain(providerToolCallId)
  })

  it("converts an Effect Tool transport failure inside the Tool span", async () => {
    const privateCanary = "private-tool-transport-error-7721"
    modelHarness.state.responses.push(
      toolResponse(fauxToolCall("reminder_list", {}, { id: "call-effect-failure" }))
    )
    const telemetry = makeCaptureTelemetry({
      serviceName: "bob-agent",
      serviceVersion: "0123456789abcdef0123456789abcdef01234567",
      deploymentEnvironment: "test"
    })
    const fallback = vi.fn(async () => okResult("unexpected"))
    const agent = createBobPiAgent({
      credentials: { read: async () => undefined } as never,
      provider: "openai-codex",
      model: "gpt-test",
      allowedModels: ["gpt-test"],
      executeTool: fallback,
      executeToolEffect: () => Effect.fail(new Error(privateCanary)),
      now: () => 1
    })

    const output = await Effect.runPromise(
      agent
        .runTurnEffect(
          baseRequest({
            userText: "Hello Bob",
            allowedTools: ["reminder_list"]
          })
        )
        .pipe(Effect.provide(telemetry.layer))
    )

    expect(output).toMatchObject({ status: "failed", errorCode: "policy", toolCalls: 1 })
    expect(fallback).not.toHaveBeenCalled()
    const invoke = telemetry.finishedSpans().find((span) => span.name === "bob.tool.invoke")
    expect(invoke?.outcome).toBe("failed")
    expect(invoke?.events).toContainEqual(
      expect.objectContaining({
        name: "bob.decision.policy",
        attributes: {
          "bob.decision.code": "provider_failure",
          "bob.decision.outcome": "denied"
        }
      })
    )
    expect(
      JSON.stringify(telemetry.finishedSpans(), (_key, value) =>
        typeof value === "bigint" ? value.toString() : value
      )
    ).not.toContain(privateCanary)
  })

  it("traces output repair as a nested repair turn", async () => {
    modelHarness.state.responses.push(
      fauxAssistantMessage("not json", { stopReason: "stop" }),
      structuredResponse({ responseText: "Hello. How can I help?" })
    )
    const telemetry = makeCaptureTelemetry({
      serviceName: "bob-agent",
      serviceVersion: "0123456789abcdef0123456789abcdef01234567",
      deploymentEnvironment: "test"
    })
    const agent = makeAgent(async () => okResult())

    const output = await Effect.runPromise(
      agent
        .runTurnEffect(baseRequest({ userText: "Hello Bob", allowedTools: [] }))
        .pipe(Effect.provide(telemetry.layer))
    )

    expect(output).toMatchObject({ status: "completed", responseText: "Hello. How can I help?" })
    const spans = telemetry.finishedSpans()
    const loop = spans.find((span) => span.name === "bob.agent.loop")
    const repair = spans.find((span) => span.name === "bob.output.repair")
    const repairTurn = spans.find(
      (span) => span.name === "bob.agent.turn" && span.attributes["bob.turn.phase"] === "repair"
    )
    const repairModel = spans.find(
      (span) => span.name === "bob.model.complete" && span.attributes["bob.turn.phase"] === "repair"
    )
    const validations = spans.filter((span) => span.name === "bob.output.validate")
    expect(repair?.parentSpanId).toBe(loop?.spanId)
    expect(repairTurn?.parentSpanId).toBe(repair?.spanId)
    expect(repairModel?.parentSpanId).toBe(repairTurn?.spanId)
    expect(validations).toHaveLength(2)
    expect(validations[1]?.parentSpanId).toBe(repair?.spanId)
    expect(repair?.events).toContainEqual(
      expect.objectContaining({
        name: "bob.decision.output",
        attributes: {
          "bob.decision.code": "repair_succeeded",
          "bob.decision.outcome": "applied"
        }
      })
    )
  })

  it("traces closed validation codes without model response content", async () => {
    const privateCanary = "private-output-canary-8841"
    modelHarness.state.responses.push(
      fauxAssistantMessage(`${privateCanary}-primary`, { stopReason: "stop" }),
      fauxAssistantMessage(`${privateCanary}-repair`, { stopReason: "stop" })
    )
    const telemetry = makeCaptureTelemetry({
      serviceName: "bob-agent",
      serviceVersion: "0123456789abcdef0123456789abcdef01234567",
      deploymentEnvironment: "test"
    })
    const agent = makeAgent(async () => okResult())

    const output = await Effect.runPromise(
      agent
        .runTurnEffect(baseRequest({ userText: "Hello Bob", allowedTools: [] }))
        .pipe(Effect.provide(telemetry.layer))
    )

    expect(output).toMatchObject({ status: "failed", errorCode: "invalid_output" })
    const validations = telemetry
      .finishedSpans()
      .filter((span) => span.name === "bob.output.validate")
    expect(validations).toHaveLength(2)
    for (const validation of validations) {
      expect(validation.events).toContainEqual(
        expect.objectContaining({
          name: "bob.decision.output",
          attributes: {
            "bob.decision.code": "repair_required",
            "bob.decision.outcome": "selected",
            "bob.output.validation_code": "malformed_response"
          }
        })
      )
    }
    expect(
      JSON.stringify(telemetry.finishedSpans(), (_key, value) =>
        typeof value === "bigint" ? value.toString() : value
      )
    ).not.toContain(privateCanary)
  })

  it("validates only the signed final answer when Codex also returns commentary", async () => {
    modelHarness.state.responses.push(
      phasedStructuredResponse("Preparing the structured response.", {
        responseText: "We can review your training plan together."
      })
    )
    const agent = makeAgent(async () => okResult())

    await expect(
      agent.runTurn(
        baseRequest({
          userText: "Help me plan today's training.",
          allowedTools: ["routine_get"]
        })
      )
    ).resolves.toMatchObject({
      status: "completed",
      responseText: "We can review your training plan together.",
      toolCalls: 0
    })
    expect(modelHarness.completeSimple).toHaveBeenCalledTimes(1)
  })

  it("uses an unphased final answer when Codex phases only its commentary", async () => {
    modelHarness.state.responses.push(
      phasedStructuredResponse(
        "Preparing the structured response.",
        { responseText: "We can review your training plan together." },
        false
      )
    )
    const agent = makeAgent(async () => okResult())

    await expect(
      agent.runTurn(
        baseRequest({
          userText: "Help me plan today's training.",
          allowedTools: ["routine_get"]
        })
      )
    ).resolves.toMatchObject({
      status: "completed",
      responseText: "We can review your training plan together.",
      toolCalls: 0
    })
    expect(modelHarness.completeSimple).toHaveBeenCalledTimes(1)
  })

  it("executes tool calls through pi-ai, then validates the final response", async () => {
    modelHarness.state.responses.push(
      toolResponse(fauxToolCall("memory_search", { query: "routine" }, { id: "call-1" })),
      structuredResponse({
        responseText: "You prefer morning training.",
        sourceIds: ["fact-revision-1"],
        toolNames: ["memory_search"]
      })
    )
    const commands: ToolCommand[] = []
    const agent = makeAgent(async (command) => {
      commands.push(command)
      return {
        ok: true,
        code: "memory_results",
        message: "One source found.",
        data: {
          matches: [
            {
              id: "search-document-1",
              sourceId: "fact-revision-1",
              text: "I prefer morning training.",
              sourceLabel: "Owner message linked on 11 Aug 2026",
              occurredAt: "2026-08-11T10:00:00.000Z"
            }
          ]
        }
      }
    })

    await expect(agent.runTurn(baseRequest())).resolves.toMatchObject({
      status: "completed",
      responseText: "You prefer morning training.",
      sourceIds: ["fact-revision-1"],
      toolCalls: 1,
      model: "gpt-test"
    })
    expect(commands).toHaveLength(1)
    expect(commands[0]).toMatchObject({
      name: "memory_search",
      toolCallId: "call-1",
      idempotencyKey: "00000000-0000-4000-8000-000000000001:call-1",
      arguments: { query: "routine" }
    })
    expect(modelHarness.completeSimple).toHaveBeenCalledTimes(2)
    const secondContext = modelHarness.state.contexts[1] as Context
    expect(secondContext.messages.at(-1)).toMatchObject({
      role: "toolResult",
      toolCallId: "call-1",
      toolName: "memory_search",
      isError: false
    })
    const toolMessage = secondContext.messages.at(-1)
    const toolContent = toolMessage?.role === "toolResult" ? toolMessage.content[0] : undefined
    expect(JSON.parse(toolContent?.type === "text" ? toolContent.text : "")).toMatchObject({
      taint: "untrusted_tool_data",
      instruction: false,
      toolName: "memory_search",
      toolCallId: "call-1"
    })
  })

  it("runs multiple tool calls in one pi-ai response in order", async () => {
    modelHarness.state.responses.push(
      toolResponse(
        fauxToolCall("reminder_list", {}, { id: "call-reminders" }),
        fauxToolCall("connection_list", {}, { id: "call-connections" })
      ),
      structuredResponse({
        responseText: "I checked your reminders and connections.",
        toolNames: ["reminder_list", "connection_list"]
      })
    )
    const commands: ToolCommand[] = []
    const agent = makeAgent(async (command) => {
      commands.push(command)
      return command.name === "reminder_list"
        ? okResult("reminder_list", "No reminders.")
        : okResult("connection_list", "No connections.")
    })

    await expect(
      agent.runTurn(
        baseRequest({
          userText: "Check reminders and connections.",
          allowedTools: ["reminder_list", "connection_list"]
        })
      )
    ).resolves.toMatchObject({ status: "completed", toolCalls: 2 })
    expect(commands.map((command) => [command.name, command.toolCallId])).toEqual([
      ["reminder_list", "call-reminders"],
      ["connection_list", "call-connections"]
    ])
  })

  it("uses deterministic safety text when a domain tool fails", async () => {
    modelHarness.state.responses.push(
      toolResponse(fauxToolCall("memory_search", { query: "routine" }, { id: "call-1" }))
    )
    const agent = makeAgent(async () => ({
      ok: false,
      code: "policy_denied",
      message: "Reminder created successfully."
    }))

    await expect(agent.runTurn(baseRequest())).resolves.toMatchObject({
      status: "failed",
      errorCode: "policy",
      responseText: "I could not complete that request safely. Open Bob to review the result."
    })
  })

  it("does not execute malformed tool arguments", async () => {
    modelHarness.state.responses.push(
      toolResponse(fauxToolCall("memory_search", {}, { id: "bad-call" }))
    )
    const executeTool = vi.fn(async () => okResult("memory_results", "Unexpected execution."))
    const agent = makeAgent(executeTool)

    await expect(agent.runTurn(baseRequest())).resolves.toMatchObject({
      status: "failed",
      errorCode: "invalid_output",
      toolCalls: 0
    })
    expect(executeTool).not.toHaveBeenCalled()
  })

  it("stops before a tool call limit can be exceeded", async () => {
    modelHarness.state.responses.push(
      toolResponse(fauxToolCall("reminder_list", {}, { id: "call-1" })),
      toolResponse(fauxToolCall("reminder_list", {}, { id: "call-2" }))
    )
    const executeTool = vi.fn(async () => okResult("reminder_list", "No reminders."))
    const agent = makeAgent(executeTool)

    await expect(
      agent.runTurn(
        baseRequest({
          allowedTools: ["reminder_list"],
          limits: { ...baseRequest().limits, maxToolCalls: 1 }
        })
      )
    ).resolves.toMatchObject({ status: "failed", toolCalls: 1 })
    expect(executeTool).toHaveBeenCalledTimes(1)
  })

  it("repairs one invalid response with tools disabled", async () => {
    modelHarness.state.responses.push(
      fauxAssistantMessage("not json", { stopReason: "stop" }),
      structuredResponse({ responseText: "Hello. How can I help?" })
    )
    const agent = makeAgent(async () => okResult())

    await expect(
      agent.runTurn(baseRequest({ userText: "Hello Bob", allowedTools: [] }))
    ).resolves.toMatchObject({ status: "completed", responseText: "Hello. How can I help?" })
    expect(modelHarness.completeSimple).toHaveBeenCalledTimes(2)
    const repairContext = modelHarness.state.contexts[1] as Context
    expect(repairContext.tools).toEqual([])
    expect(repairContext.messages.at(-1)).toMatchObject({ role: "user" })
    expect(String(repairContext.messages.at(-1)?.content)).toContain("failed validation")
  })

  it("repairs an unsupported conflict without inventing a saved conflict", async () => {
    modelHarness.state.responses.push(
      structuredResponse({
        responseText: "I found conflicting saved information.",
        conflict: "disclosed"
      }),
      (context: Context) => {
        const instruction = String(context.messages.at(-1)?.content)
        return instruction.includes('Set "conflict" to "none"') &&
          instruction.includes("Remove unsupported conflict claims")
          ? structuredResponse({ responseText: "I can compare the two options you described." })
          : fauxAssistantMessage("still not json", { stopReason: "stop" })
      }
    )
    const agent = makeAgent(async () => okResult())

    await expect(
      agent.runTurn(
        baseRequest({
          userText: "Compare two invented training plans without changing anything.",
          allowedTools: []
        })
      )
    ).resolves.toMatchObject({
      status: "completed",
      responseText: "I can compare the two options you described.",
      conflict: "none"
    })
  })

  it("validates only the signed final answer from a repair turn", async () => {
    modelHarness.state.responses.push(
      fauxAssistantMessage("not json", { stopReason: "stop" }),
      phasedStructuredResponse("Correcting the response format.", {
        responseText: "Hello. How can I help?"
      })
    )
    const agent = makeAgent(async () => okResult())

    await expect(
      agent.runTurn(baseRequest({ userText: "Hello Bob", allowedTools: [] }))
    ).resolves.toMatchObject({
      status: "completed",
      responseText: "Hello. How can I help?",
      toolCalls: 0
    })
    expect(modelHarness.completeSimple).toHaveBeenCalledTimes(2)
  })

  it("returns timeout for a non-cooperative pi-ai call and aborts its signal", async () => {
    let observedSignal: AbortSignal | undefined
    modelHarness.completeSimple.mockImplementation(
      async (_model: unknown, _context: unknown, options: unknown) => {
        observedSignal = (options as { signal?: AbortSignal }).signal
        return await new Promise<never>(() => undefined)
      }
    )
    const agent = makeAgent(async () => okResult())
    const telemetry = makeCaptureTelemetry({
      serviceName: "bob-agent",
      serviceVersion: "0123456789abcdef0123456789abcdef01234567",
      deploymentEnvironment: "test"
    })

    const output = await Effect.runPromise(
      agent
        .runTurnEffect(baseRequest({ limits: { ...baseRequest().limits, maxDurationMs: 5 } }))
        .pipe(Effect.provide(telemetry.layer))
    )
    expect(output).toMatchObject({ status: "cancelled", errorCode: "timeout" })
    expect(
      telemetry.finishedSpans().find((span) => span.name === "bob.model.complete")?.outcome
    ).toBe("failed")
    expect(observedSignal?.aborted).toBe(true)
  })

  it("cancels active model work when the caller aborts", async () => {
    let observedSignal: AbortSignal | undefined
    let markStarted!: () => void
    const started = new Promise<void>((resolve) => {
      markStarted = resolve
    })
    modelHarness.completeSimple.mockImplementation(
      async (_model: unknown, _context: unknown, options: unknown) => {
        observedSignal = (options as { signal?: AbortSignal }).signal
        markStarted()
        return await new Promise<never>((_resolve, reject) => {
          const rejectAsAborted = () => {
            const error = new Error("Request stopped.")
            error.name = "AbortError"
            reject(error)
          }
          if (observedSignal?.aborted === true) rejectAsAborted()
          else observedSignal?.addEventListener("abort", rejectAsAborted, { once: true })
        })
      }
    )
    const controller = new AbortController()
    const agent = makeAgent(async () => okResult())
    const run = agent.runTurn(
      baseRequest({ limits: { ...baseRequest().limits, maxDurationMs: 100 } }),
      controller.signal
    )

    await started
    controller.abort("newer_turn_revision")

    await expect(run).resolves.toMatchObject({ status: "cancelled", errorCode: "cancelled" })
    expect(observedSignal?.aborted).toBe(true)
  })

  it("returns cancellation when an aborted model call does not settle", async () => {
    let markStarted!: () => void
    const started = new Promise<void>((resolve) => {
      markStarted = resolve
    })
    modelHarness.completeSimple.mockImplementation(async () => {
      markStarted()
      return await new Promise<never>(() => undefined)
    })
    const controller = new AbortController()
    const agent = makeAgent(async () => okResult())
    const run = agent.runTurn(
      baseRequest({ limits: { ...baseRequest().limits, maxDurationMs: 500 } }),
      controller.signal
    )

    await started
    controller.abort("newer_turn_revision")
    const outcome = await Promise.race([
      run.then((result) => ({ type: "result" as const, result })),
      new Promise<{ type: "guard" }>((resolve) => setTimeout(() => resolve({ type: "guard" }), 250))
    ])

    expect(outcome).toMatchObject({
      type: "result",
      result: { status: "cancelled", errorCode: "cancelled" }
    })
  })

  it("returns timeout when a tool execution never resolves", async () => {
    modelHarness.state.responses.push(
      toolResponse(fauxToolCall("reminder_list", {}, { id: "hung-tool-call" }))
    )
    let observedSignal: AbortSignal | undefined
    const agent = makeAgent(async (_command, signal) => {
      observedSignal = signal
      return new Promise<ToolResult>(() => undefined)
    })
    const telemetry = makeCaptureTelemetry({
      serviceName: "bob-agent",
      serviceVersion: "0123456789abcdef0123456789abcdef01234567",
      deploymentEnvironment: "test"
    })
    const run = Effect.runPromise(
      agent
        .runTurnEffect(
          baseRequest({
            userText: "List my reminders.",
            allowedTools: ["reminder_list"],
            limits: { ...baseRequest().limits, maxDurationMs: 5 }
          })
        )
        .pipe(Effect.provide(telemetry.layer))
    )
    let guardTimer: ReturnType<typeof setTimeout> | undefined
    const outcome = await Promise.race([
      run.then((result) => ({ type: "result" as const, result })),
      new Promise<{ type: "guard" }>((resolve) => {
        guardTimer = setTimeout(() => resolve({ type: "guard" }), 250)
      })
    ])
    if (guardTimer !== undefined) clearTimeout(guardTimer)

    expect(outcome.type).toBe("result")
    if (outcome.type === "result") {
      expect(outcome.result).toMatchObject({ status: "cancelled", errorCode: "timeout" })
    }
    expect(observedSignal?.aborted).toBe(true)
    expect(telemetry.finishedSpans().find((span) => span.name === "bob.tool.invoke")?.outcome).toBe(
      "failed"
    )
  })

  it("cancels active read-only Tool work when the caller aborts", async () => {
    modelHarness.state.responses.push(
      toolResponse(fauxToolCall("reminder_list", {}, { id: "read-call" }))
    )
    let observedSignal: AbortSignal | undefined
    let markStarted!: () => void
    const started = new Promise<void>((resolve) => {
      markStarted = resolve
    })
    const agent = makeAgent(async (_command, signal) => {
      observedSignal = signal
      markStarted()
      return await new Promise<ToolResult>(() => undefined)
    })
    const controller = new AbortController()
    const run = agent.runTurn(
      baseRequest({
        userText: "List my reminders.",
        allowedTools: ["reminder_list"],
        limits: { ...baseRequest().limits, maxDurationMs: 500 }
      }),
      controller.signal
    )

    await started
    controller.abort("newer_turn_revision")
    const outcome = await Promise.race([
      run.then((result) => ({ type: "result" as const, result })),
      new Promise<{ type: "guard" }>((resolve) => setTimeout(() => resolve({ type: "guard" }), 250))
    ])

    expect(outcome).toMatchObject({
      type: "result",
      result: { status: "cancelled", errorCode: "cancelled" }
    })
    expect(observedSignal?.aborted).toBe(true)
  })

  it("lets an active mutating Tool settle before cancellation", async () => {
    modelHarness.state.responses.push(
      toolResponse(
        fauxToolCall("settings_update", { timeZone: "Europe/Stockholm" }, { id: "write-call" })
      )
    )
    let observedSignal: AbortSignal | undefined
    let markStarted!: () => void
    const started = new Promise<void>((resolve) => {
      markStarted = resolve
    })
    let completeTool!: (result: ToolResult) => void
    const toolResult = new Promise<ToolResult>((resolve) => {
      completeTool = resolve
    })
    const agent = makeAgent(async (_command, signal) => {
      observedSignal = signal
      markStarted()
      return toolResult
    })
    const controller = new AbortController()
    const run = agent.runTurn(
      baseRequest({
        userText: "Use Stockholm time.",
        allowedTools: ["settings_update"],
        limits: { ...baseRequest().limits, maxDurationMs: 500 }
      }),
      controller.signal
    )

    await started
    controller.abort("newer_turn_revision")
    const beforeSettle = await Promise.race([
      run.then(() => "resolved" as const),
      new Promise<"waiting">((resolve) => setTimeout(() => resolve("waiting"), 25))
    ])

    expect(beforeSettle).toBe("waiting")
    expect(observedSignal).toBeUndefined()
    completeTool(okResult("settings_updated", "Settings updated."))
    await expect(run).resolves.toMatchObject({ status: "cancelled", errorCode: "cancelled" })
  })

  it("lets a claimed mutation settle after the agent run timeout", async () => {
    modelHarness.state.responses.push(
      toolResponse(
        fauxToolCall("settings_update", { timeZone: "Europe/Stockholm" }, { id: "slow-write" })
      )
    )
    let observedSignal: AbortSignal | undefined
    let markStarted!: () => void
    const started = new Promise<void>((resolve) => {
      markStarted = resolve
    })
    let completeTool!: (result: ToolResult) => void
    const toolResult = new Promise<ToolResult>((resolve) => {
      completeTool = resolve
    })
    const agent = makeAgent(async (_command, signal) => {
      observedSignal = signal
      markStarted()
      return toolResult
    })
    const run = agent.runTurn(
      baseRequest({
        conversationTurnId: "00000000-0000-4000-8000-000000000010",
        conversationTurnRevision: 1,
        userText: "Use Stockholm time.",
        allowedTools: ["settings_update"],
        limits: { ...baseRequest().limits, maxDurationMs: 20 }
      })
    )

    await started
    const beforeSettle = await Promise.race([
      run.then(() => "resolved" as const),
      new Promise<"waiting">((resolve) => setTimeout(() => resolve("waiting"), 40))
    ])

    expect(beforeSettle).toBe("waiting")
    expect(observedSignal).toBeUndefined()
    completeTool(okResult("owner_settings_updated", "Settings updated."))
    await expect(run).resolves.toMatchObject({ status: "cancelled", errorCode: "timeout" })
  })

  it("returns a consistent cancelled result when Pi throws AbortError", async () => {
    modelHarness.completeSimple.mockImplementation(async () => {
      const error = new Error("Request stopped.")
      error.name = "AbortError"
      throw error
    })
    const agent = makeAgent(async () => okResult())

    await expect(agent.runTurn(baseRequest())).resolves.toMatchObject({
      status: "cancelled",
      errorCode: "cancelled"
    })
  })

  it("accepts an external-action claim only after its confirming Tool succeeds", async () => {
    modelHarness.state.responses.push(
      toolResponse(
        fauxToolCall(
          "connection_link_create",
          { provider: "google_calendar" },
          { id: "connection-call" }
        )
      ),
      structuredResponse({
        responseText: "I created a calendar connection link.",
        toolNames: ["connection_link_create"]
      })
    )
    const agent = makeAgent(async () => ({
      ok: true,
      code: "connection_link_created",
      message: "A short-lived connection link is ready in Bob."
    }))

    await expect(
      agent.runTurn(
        baseRequest({
          userText: "Connect my calendar.",
          allowedTools: ["connection_link_create"]
        })
      )
    ).resolves.toMatchObject({
      status: "completed",
      responseText: "I created a calendar connection link."
    })
  })

  it("rejects a model-only source claim", async () => {
    modelHarness.state.responses.push(
      toolResponse(fauxToolCall("memory_search", { query: "routine" }, { id: "call-1" })),
      structuredResponse({
        responseText: "You prefer evening training.",
        sourceIds: ["model-claimed-source"],
        toolNames: ["memory_search"]
      })
    )
    const agent = makeAgent(async () => ({
      ok: true,
      code: "memory_results",
      message: "One source found.",
      data: {
        matches: [
          {
            id: "search-document-1",
            sourceId: "fact-revision-1",
            text: "I prefer morning training.",
            sourceLabel: "Owner message linked on 11 Aug 2026"
          }
        ]
      }
    }))

    await expect(agent.runTurn(baseRequest())).resolves.toMatchObject({
      status: "failed",
      errorCode: "invalid_output"
    })
  })

  it("uses the no-supported-record fallback when recall has no trusted source", async () => {
    modelHarness.state.responses.push(
      toolResponse(fauxToolCall("memory_search", { query: "routine" }, { id: "call-1" })),
      structuredResponse({
        responseText: "You train on Tuesdays.",
        toolNames: ["memory_search"]
      })
    )
    const agent = makeAgent(async () => ({
      ok: true,
      code: "memory_results",
      message: "No sources found.",
      data: { matches: [] }
    }))

    await expect(agent.runTurn(baseRequest())).resolves.toMatchObject({
      status: "failed",
      errorCode: "policy",
      responseText: "I do not have a supported record for that."
    })
  })

  it("requires grounding when an earlier turn message asks for personal recall", async () => {
    modelHarness.state.responses.push(
      toolResponse(fauxToolCall("memory_search", { query: "routine" }, { id: "call-1" })),
      structuredResponse({
        responseText: "You train on Tuesdays.",
        toolNames: ["memory_search"]
      })
    )
    const agent = makeAgent(async () => ({
      ok: true,
      code: "memory_results",
      message: "No sources found.",
      data: { matches: [] }
    }))
    const targetMessageId = "00000000-0000-4000-8000-000000000004"

    await expect(
      agent.runTurn(
        baseRequest({
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
        })
      )
    ).resolves.toMatchObject({
      status: "failed",
      errorCode: "policy",
      responseText: "I do not have a supported record for that."
    })
  })

  it("completes an empty reminder list with trusted record-set grounding", async () => {
    modelHarness.state.responses.push(
      toolResponse(fauxToolCall("reminder_list", {}, { id: "call-reminders" })),
      structuredResponse({
        responseText: "You have no active reminders.",
        toolNames: ["reminder_list"]
      })
    )
    const agent = makeAgent(async () => ({
      ok: true,
      code: "reminder_list",
      message: "0 reminders found.",
      data: { reminders: [] }
    }))
    const telemetry = makeCaptureTelemetry({
      serviceName: "bob-agent",
      serviceVersion: "0123456789abcdef0123456789abcdef01234567",
      deploymentEnvironment: "test"
    })
    const request = baseRequest({
      userText: "List my reminders.",
      allowedTools: ["reminder_list"]
    })

    const output = await Effect.runPromise(
      agent.runTurnEffect(request).pipe(Effect.provide(telemetry.layer))
    )

    expect(output).toMatchObject({
      status: "completed",
      responseText: "You have no active reminders.",
      sourceIds: ["bob:active-reminders"],
      trustedToolSources: [
        {
          sourceId: "bob:active-reminders",
          sourceLabel: "Bob active reminders"
        }
      ]
    })
    const loop = telemetry.finishedSpans().find((span) => span.name === "bob.agent.loop")
    expect(loop?.events).toContainEqual(
      expect.objectContaining({
        name: "bob.decision.grounding",
        attributes: {
          "bob.decision.code": "grounding_present",
          "bob.decision.outcome": "allowed",
          "bob.selected.count": 1
        }
      })
    )
    expect(loop?.events).not.toContainEqual(
      expect.objectContaining({
        attributes: expect.objectContaining({ "bob.decision.code": "grounding_missing" })
      })
    )
  })

  it("replaces unrelated model text after an empty reminder list", async () => {
    modelHarness.state.responses.push(
      toolResponse(fauxToolCall("reminder_list", {}, { id: "call-reminders" })),
      structuredResponse({
        responseText: "Du tränar på tisdagar.",
        toolNames: ["reminder_list"]
      })
    )
    const agent = makeAgent(async () => ({
      ok: true,
      code: "reminder_list",
      message: "0 reminders found.",
      data: { reminders: [] }
    }))

    await expect(
      agent.runTurn(
        baseRequest({
          userText: "Lista mina påminnelser.",
          locale: "sv-SE",
          allowedTools: ["reminder_list"]
        })
      )
    ).resolves.toMatchObject({
      status: "completed",
      responseText: "Du har inga aktiva påminnelser.",
      sourceIds: ["bob:active-reminders"]
    })
  })

  it("uses a later nonempty reminder list instead of a stale empty result", async () => {
    modelHarness.state.responses.push(
      toolResponse(fauxToolCall("reminder_list", {}, { id: "call-reminders-empty" })),
      toolResponse(fauxToolCall("reminder_list", {}, { id: "call-reminders-current" })),
      structuredResponse({
        responseText: "Your active reminder is due tomorrow at 09:00.",
        sourceIds: ["reminder-occurrence-1"],
        toolNames: ["reminder_list"]
      })
    )
    const results = [
      {
        ok: true,
        code: "reminder_list",
        message: "0 reminders found.",
        data: { reminders: [] }
      },
      {
        ok: true,
        code: "reminder_list",
        message: "1 reminder found.",
        data: {
          reminders: [
            {
              id: "reminder-1",
              displayText: "Morning task",
              localDisplayTime: "2026-08-12 09:00",
              timeZone: "Europe/Stockholm",
              state: "active",
              actionTargets: []
            }
          ]
        }
      }
    ] satisfies ToolResult[]
    const agent = makeAgent(async () => {
      const result = results.shift()
      if (result === undefined) throw new Error("No scripted Tool result remains")
      return result
    })

    await expect(
      agent.runTurn(
        baseRequest({
          userText: "List my reminders.",
          allowedTools: ["reminder_list"],
          contextItems: [
            {
              kind: "reminder",
              text: "Morning task. Due 2026-08-12 09:00 Europe/Stockholm. State active.",
              instruction: false,
              conflict: false,
              sources: [
                {
                  sourceId: "reminder-occurrence-1",
                  sourceLabel: "reminder 2026-08-12"
                }
              ]
            }
          ]
        })
      )
    ).resolves.toMatchObject({
      status: "completed",
      responseText: "Your active reminder is due tomorrow at 09:00.",
      sourceIds: ["reminder-occurrence-1"]
    })
  })

  it("completes a nonempty reminder list when the response cites its approved source", async () => {
    modelHarness.state.responses.push(
      toolResponse(fauxToolCall("reminder_list", {}, { id: "call-reminders" })),
      structuredResponse({
        responseText: "Your active reminder is due tomorrow at 09:00.",
        sourceIds: ["reminder-occurrence-1"],
        toolNames: ["reminder_list"]
      })
    )
    const agent = makeAgent(async () => ({
      ok: true,
      code: "reminder_list",
      message: "1 reminder found.",
      data: {
        reminders: [
          {
            id: "reminder-1",
            displayText: "Morning task",
            localDisplayTime: "2026-08-12 09:00",
            timeZone: "Europe/Stockholm",
            state: "active",
            actionTargets: []
          }
        ]
      }
    }))

    await expect(
      agent.runTurn(
        baseRequest({
          userText: "List my reminders.",
          allowedTools: ["reminder_list"],
          contextItems: [
            {
              kind: "reminder",
              text: "Morning task. Due 2026-08-12 09:00 Europe/Stockholm. State active.",
              instruction: false,
              conflict: false,
              sources: [
                {
                  sourceId: "reminder-occurrence-1",
                  sourceLabel: "reminder 2026-08-12"
                }
              ]
            }
          ]
        })
      )
    ).resolves.toMatchObject({
      status: "completed",
      responseText: "Your active reminder is due tomorrow at 09:00.",
      sourceIds: ["reminder-occurrence-1"]
    })
  })

  it("rejects an unsourced nonempty reminder list", async () => {
    modelHarness.state.responses.push(
      toolResponse(fauxToolCall("reminder_list", {}, { id: "call-reminders" })),
      structuredResponse({
        responseText: "Your active reminder is due tomorrow at 09:00.",
        toolNames: ["reminder_list"]
      })
    )
    const agent = makeAgent(async () => ({
      ok: true,
      code: "reminder_list",
      message: "1 reminder found.",
      data: {
        reminders: [
          {
            id: "reminder-1",
            displayText: "Morning task",
            localDisplayTime: "2026-08-12 09:00",
            timeZone: "Europe/Stockholm",
            state: "active",
            actionTargets: []
          }
        ]
      }
    }))

    await expect(
      agent.runTurn(
        baseRequest({
          userText: "List my reminders.",
          allowedTools: ["reminder_list"]
        })
      )
    ).resolves.toMatchObject({
      status: "failed",
      errorCode: "policy",
      responseText: "I do not have a supported record for that."
    })
  })

  it("allows a greeting without citations when profile context is present", async () => {
    modelHarness.state.responses.push(
      structuredResponse({ responseText: "Hello. How can I help?" })
    )
    const agent = makeAgent(async () => okResult())

    await expect(
      agent.runTurn(
        baseRequest({
          userText: "Hello Bob",
          allowedTools: [],
          contextItems: [
            {
              kind: "profile",
              text: "The owner prefers morning training.",
              instruction: false,
              conflict: false,
              sources: [{ sourceId: "fact-revision-1", sourceLabel: "Owner message" }]
            }
          ]
        })
      )
    ).resolves.toMatchObject({ status: "completed", sourceIds: [] })
  })
})
