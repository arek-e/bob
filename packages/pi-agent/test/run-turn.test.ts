import type { AgentRunRequest } from "@bob/contracts/agent"
import type { ToolCommand, ToolResult } from "@bob/contracts/tools"

import {
  fauxAssistantMessage,
  fauxToolCall,
  type AssistantMessage,
  type Context
} from "@earendil-works/pi-ai"
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
      id: "test-model",
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

const makeAgent = (
  executeTool: (command: ToolCommand, signal?: AbortSignal) => Promise<ToolResult>,
  now: () => number = () => 1
) =>
  createBobPiAgent({
    credentials: { read: async () => undefined } as never,
    provider: "openai-codex",
    model: "test-model",
    allowedModels: ["test-model"],
    executeTool,
    now
  })

const okResult = (code = "test", message = "Done."): ToolResult => ({ ok: true, code, message })

describe("Bob's direct pi-ai loop", () => {
  beforeEach(() => {
    modelHarness.reset()
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
      model: "test-model"
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

  it("returns timeout for a non-cooperative pi-ai call and aborts its signal", async () => {
    let observedSignal: AbortSignal | undefined
    modelHarness.completeSimple.mockImplementation(
      async (_model: unknown, _context: unknown, options: unknown) => {
        observedSignal = (options as { signal?: AbortSignal }).signal
        return await new Promise<never>(() => undefined)
      }
    )
    const agent = makeAgent(async () => okResult())

    await expect(
      agent.runTurn(baseRequest({ limits: { ...baseRequest().limits, maxDurationMs: 5 } }))
    ).resolves.toMatchObject({ status: "cancelled", errorCode: "timeout" })
    expect(observedSignal?.aborted).toBe(true)
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
    const run = agent.runTurn(
      baseRequest({
        userText: "List my reminders.",
        allowedTools: ["reminder_list"],
        limits: { ...baseRequest().limits, maxDurationMs: 5 }
      })
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
