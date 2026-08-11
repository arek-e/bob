import type { AgentRunRequest, AgentRunResult, DeviceLoginEvent } from "@bob/contracts/agent"
import type { ToolCommand, ToolResult } from "@bob/contracts/tools"

import {
  contentText,
  createModels,
  validateToolCall,
  type AuthEvent,
  type AuthInteraction,
  type AssistantMessage,
  type Context,
  type CredentialStore,
  type Message,
  type Tool,
  type ToolCall,
  type ToolResultMessage
} from "@earendil-works/pi-ai"
import { registerBunOAuthFlows } from "@earendil-works/pi-ai/bun-oauth"
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex"

import { waitForDeviceLoginStart } from "./device-login.ts"
import { classifyProviderError } from "./errors.ts"
import { renderRepairPrompt, renderSystemPrompt } from "./prompt.ts"
import {
  deterministicToolResultFallback,
  noSupportedRecordFallback,
  requiresPersonalGrounding,
  toolResultConfirmsAction,
  trustedToolSourcesFromResult,
  validateAssistantResponseWithRepair,
  type TrustedToolSource
} from "./response-safety.ts"
import { createTools } from "./tools.ts"

registerBunOAuthFlows()

export interface BobPiAgentOptions {
  readonly credentials: CredentialStore
  readonly provider: "openai-codex"
  readonly model: string
  readonly allowedModels: readonly string[]
  readonly executeTool: (command: ToolCommand, signal?: AbortSignal) => Promise<ToolResult>
  readonly now?: () => number
  readonly deviceLoginStartTimeoutMs?: number
}

export interface AuthStatus {
  readonly configured: boolean
  readonly provider: "openai-codex"
  readonly accountIdRedacted?: string
  readonly expiresAt?: string
}

export interface BobPiAgent {
  runTurn(request: AgentRunRequest): Promise<AgentRunResult>
  getAuthStatus(): Promise<AuthStatus>
  startDeviceLogin(): Promise<DeviceLoginEvent>
}

type Completion =
  | { readonly type: "message"; readonly message: AssistantMessage }
  | { readonly type: "timeout" }
  | FailedCompletion

type FailedCompletion = {
  readonly type: "failed"
  readonly errorMessage?: string
  readonly errorCode?: AgentRunResult["errorCode"]
}

function failedCompletion(
  errorMessage: string | undefined,
  errorCode?: AgentRunResult["errorCode"]
): FailedCompletion {
  return {
    type: "failed",
    ...(errorMessage === undefined ? {} : { errorMessage }),
    ...(errorCode === undefined ? {} : { errorCode })
  }
}

function safeToolFailure(): ToolResult {
  return {
    ok: false,
    code: "tool_execution_failed",
    message: "The tool could not complete safely."
  }
}

function toolResultMessage(
  call: ToolCall,
  result: ToolResult,
  now: () => number
): ToolResultMessage<ToolResult> {
  return {
    role: "toolResult",
    toolCallId: call.id,
    toolName: call.name,
    content: [
      {
        type: "text",
        text: JSON.stringify({
          taint: "untrusted_tool_data",
          instruction: false,
          toolName: call.name,
          toolCallId: call.id,
          result
        })
      }
    ],
    details: result,
    isError: !result.ok,
    timestamp: now()
  }
}

function toolCallsFromAssistant(message: AssistantMessage): ToolCall[] {
  return message.content.flatMap((block) => (block.type === "toolCall" ? [block] : []))
}

export function createBobPiAgent(options: BobPiAgentOptions): BobPiAgent {
  if (options.provider !== "openai-codex") throw new Error("Only openai-codex is approved")
  if (!options.allowedModels.includes(options.model))
    throw new Error("Configured model is not allowlisted")

  const models = createModels({ credentials: options.credentials })
  models.setProvider(openaiCodexProvider())
  const model = models.getModel(options.provider, options.model)
  if (model === undefined)
    throw new Error("Configured model is unavailable in the pinned Pi catalog")

  const now = options.now ?? Date.now
  let activeLogin: Promise<unknown> | undefined

  return {
    async runTurn(request) {
      const startedAt = now()
      const controller = new AbortController()
      const turnsLimit = Math.max(1, request.limits.maxTurns)
      let turns = 0
      let toolCalls = 0
      let inputTokens = 0
      let outputTokens = 0
      let timedOut = false
      const toolResults: ToolResult[] = []
      const executedToolNames = new Set<string>()
      const confirmedActionToolNames = new Set<string>()
      const approvedSourceIds = new Set(
        request.contextItems.flatMap((item) => item.sources.map((source) => source.sourceId))
      )
      const conflictingSourceIds = new Set(
        request.contextItems
          .filter((item) => item.conflict)
          .flatMap((item) => item.sources.map((source) => source.sourceId))
      )
      const trustedToolSources = new Map<string, TrustedToolSource>()
      const needsPersonalGrounding = requiresPersonalGrounding(request.userText)

      const result = (
        status: AgentRunResult["status"],
        responseText: string | undefined,
        errorCode: AgentRunResult["errorCode"] | undefined
      ): AgentRunResult => ({
        protocolVersion: 1,
        runId: request.runId,
        correlationId: request.correlationId,
        status,
        ...(responseText === undefined ? {} : { responseText }),
        ...(errorCode === undefined ? {} : { errorCode }),
        model: options.model,
        durationMs: Math.max(0, now() - startedAt),
        inputTokens,
        outputTokens,
        toolCalls
      })

      const tools = createTools({
        request,
        execute: async (command) => {
          try {
            return await options.executeTool(command, controller.signal)
          } catch {
            return safeToolFailure()
          }
        }
      })
      const modelTools: Tool[] = tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters
      }))
      const toolsByName = new Map(tools.map((tool) => [tool.name, tool]))
      const context: Context = {
        systemPrompt: renderSystemPrompt(request),
        messages: [
          {
            role: "user",
            content: request.userText,
            timestamp: now()
          }
        ],
        tools: modelTools
      }

      let timeout: ReturnType<typeof setTimeout> | undefined
      const timeoutCompletion = new Promise<{ readonly type: "timeout" }>((resolve) => {
        timeout = setTimeout(
          () => {
            timedOut = true
            controller.abort("agent_run_timeout")
            resolve({ type: "timeout" })
          },
          Math.max(1, request.limits.maxDurationMs)
        )
      })

      const complete = async (): Promise<Completion> => {
        if (turns >= turnsLimit) return failedCompletion("Turn limit reached.")
        turns += 1
        try {
          const message = await Promise.race([
            models
              .completeSimple(model, context, {
                maxRetries: 0,
                reasoning: "medium",
                signal: controller.signal,
                timeoutMs: Math.max(1, request.limits.maxDurationMs)
              })
              .then((assistant) => ({ type: "message" as const, message: assistant })),
            timeoutCompletion
          ])
          if (message.type !== "message") return message
          inputTokens += message.message.usage.input
          outputTokens += message.message.usage.output
          return message
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : undefined
          const errorCode =
            error instanceof Error && error.name === "AbortError"
              ? "cancelled"
              : classifyProviderError(errorMessage)
          return failedCompletion(errorMessage, errorCode)
        }
      }

      const executeCall = async (
        tool: (typeof tools)[number],
        call: ToolCall,
        parameters: unknown
      ): Promise<
        | {
            readonly type: "completed"
            readonly result: ToolResult
            readonly message: ToolResultMessage<ToolResult>
          }
        | { readonly type: "timeout" }
      > => {
        toolCalls += 1
        executedToolNames.add(call.name)
        const execution = await Promise.race([
          (async () => {
            try {
              return { type: "result" as const, result: await tool.execute(call.id, parameters) }
            } catch {
              return { type: "result" as const, result: safeToolFailure() }
            }
          })(),
          timeoutCompletion
        ])
        if (execution.type === "timeout") return execution

        const toolResult = execution.result
        toolResults.push(toolResult)
        for (const source of trustedToolSourcesFromResult(toolResult)) {
          if (!trustedToolSources.has(source.sourceId) && trustedToolSources.size >= 24) continue
          trustedToolSources.set(source.sourceId, source)
          approvedSourceIds.add(source.sourceId)
        }
        if (toolResultConfirmsAction(tool.label, toolResult)) {
          confirmedActionToolNames.add(call.name)
        }
        return {
          type: "completed",
          result: toolResult,
          message: toolResultMessage(call, toolResult, now)
        }
      }

      const runModelLoop = async (): Promise<
        | { readonly type: "final"; readonly message: AssistantMessage }
        | { readonly type: "timeout" }
        | FailedCompletion
      > => {
        while (turns < turnsLimit) {
          const completion = await complete()
          if (completion.type === "timeout") return completion
          if (completion.type === "failed") return completion
          const assistant = completion.message
          context.messages.push(assistant)
          if (assistant.stopReason === "aborted") {
            return failedCompletion(assistant.errorMessage ?? "aborted", "cancelled")
          }
          if (assistant.stopReason === "error") {
            return failedCompletion(assistant.errorMessage)
          }

          const calls = toolCallsFromAssistant(assistant)
          if (calls.length === 0) return { type: "final", message: assistant }

          for (const call of calls) {
            const tool = toolsByName.get(call.name)
            if (tool === undefined || !request.allowedTools.some((name) => name === call.name)) {
              toolResults.push(safeToolFailure())
              return { type: "failed", errorMessage: "Tool is not allowed for this run." }
            }
            if (toolCalls >= request.limits.maxToolCalls) {
              toolResults.push(safeToolFailure())
              return { type: "failed", errorMessage: "Tool-call limit reached." }
            }

            let parameters: unknown
            try {
              parameters = validateToolCall(modelTools, call)
            } catch {
              return failedCompletion("Tool arguments failed validation.", "invalid_output")
            }

            const execution = await executeCall(tool, call, parameters)
            if (execution.type === "timeout") return execution
            context.messages.push(execution.message)
            if (!execution.result.ok) {
              return { type: "failed", errorMessage: "The tool could not complete safely." }
            }
          }
        }
        return failedCompletion("Turn limit reached.")
      }

      try {
        const loop = await runModelLoop()
        if (loop.type === "timeout" || timedOut) {
          return result(
            "cancelled",
            deterministicToolResultFallback(toolResults, request.limits.maxResponseCharacters),
            "timeout"
          )
        }
        if (loop.type === "failed") {
          const fallback = deterministicToolResultFallback(
            toolResults,
            request.limits.maxResponseCharacters
          )
          const errorCode =
            loop.errorCode ??
            (loop.errorMessage === "Turn limit reached."
              ? "invalid_output"
              : toolResults.some((toolResult) => !toolResult.ok)
                ? "policy"
                : classifyProviderError(loop.errorMessage))
          return result(
            errorCode === "cancelled" || errorCode === "timeout" ? "cancelled" : "failed",
            fallback,
            errorCode
          )
        }

        if (toolResults.some((toolResult) => !toolResult.ok)) {
          return result(
            "failed",
            deterministicToolResultFallback(toolResults, request.limits.maxResponseCharacters),
            "policy"
          )
        }
        if (needsPersonalGrounding && approvedSourceIds.size === 0) {
          return result("failed", noSupportedRecordFallback(request.locale), "policy")
        }

        const modelMessage = loop.message
        let repairTimedOut = false
        const validated = await validateAssistantResponseWithRepair(
          contentText(modelMessage.content).trim(),
          {
            maxResponseCharacters: request.limits.maxResponseCharacters,
            approvedSourceIds,
            requiresSource: needsPersonalGrounding,
            conflictingSourceIds,
            executedToolNames,
            confirmedActionToolNames
          },
          turns < turnsLimit && !controller.signal.aborted
            ? async (validationCode) => {
                context.tools = []
                const repairMessage: Message = {
                  role: "user",
                  content: renderRepairPrompt(validationCode),
                  timestamp: now()
                }
                context.messages.push(repairMessage)
                const completion = await complete()
                if (completion.type === "timeout") {
                  repairTimedOut = true
                  throw new Error("Agent run timed out.")
                }
                if (completion.type !== "message") {
                  throw new Error(completion.errorMessage ?? "Response repair failed")
                }
                if (
                  completion.message.stopReason === "error" ||
                  completion.message.stopReason === "aborted"
                ) {
                  throw new Error(completion.message.errorMessage ?? "Response repair failed")
                }
                if (toolCallsFromAssistant(completion.message).length > 0) {
                  throw new Error("Response repair attempted a tool call")
                }
                context.messages.push(completion.message)
                return contentText(completion.message.content).trim()
              }
            : undefined
        )

        if (repairTimedOut || timedOut) {
          return result(
            "cancelled",
            deterministicToolResultFallback(toolResults, request.limits.maxResponseCharacters),
            "timeout"
          )
        }
        if (!validated.ok) {
          return result(
            "failed",
            deterministicToolResultFallback(toolResults, request.limits.maxResponseCharacters),
            "invalid_output"
          )
        }
        return {
          ...result("completed", validated.value.responseText, undefined),
          sourceIds: validated.value.sourceIds,
          ...(trustedToolSources.size === 0
            ? {}
            : { trustedToolSources: [...trustedToolSources.values()].slice(0, 24) }),
          conflict: validated.value.conflict
        }
      } finally {
        if (timeout !== undefined) clearTimeout(timeout)
      }
    },

    async getAuthStatus() {
      const credential = await options.credentials.read("openai-codex")
      if (credential?.type !== "oauth") return { configured: false, provider: "openai-codex" }
      const accountId = typeof credential.accountId === "string" ? credential.accountId : undefined
      return {
        configured: true,
        provider: "openai-codex",
        ...(accountId === undefined
          ? {}
          : { accountIdRedacted: `…${accountId.slice(Math.max(0, accountId.length - 4))}` }),
        expiresAt: new Date(credential.expires).toISOString()
      }
    },

    async startDeviceLogin() {
      if (activeLogin !== undefined) {
        return { type: "failed", code: "login_already_active" }
      }
      let resolveEvent!: (event: DeviceLoginEvent) => void
      const firstEvent = new Promise<DeviceLoginEvent>((resolve) => {
        resolveEvent = resolve
      })
      let eventSent = false
      const interaction: AuthInteraction = {
        async prompt(prompt) {
          if (prompt.type === "select") {
            const device = prompt.options.find((option) => option.id === "device_code")
            if (device === undefined) throw new Error("Device login is unavailable")
            return device.id
          }
          throw new Error("Unexpected interactive prompt during device login")
        },
        notify(event: AuthEvent) {
          if (event.type === "device_code" && !eventSent) {
            eventSent = true
            resolveEvent({
              type: "device_code",
              verificationUri: event.verificationUri,
              userCode: event.userCode,
              expiresAt: new Date(now() + (event.expiresInSeconds ?? 900) * 1_000).toISOString()
            })
          }
        }
      }
      activeLogin = models
        .login("openai-codex", "oauth", interaction)
        .catch(() => {
          if (!eventSent) resolveEvent({ type: "failed", code: "device_login_failed" })
        })
        .finally(() => {
          activeLogin = undefined
        })
      return waitForDeviceLoginStart(firstEvent, options.deviceLoginStartTimeoutMs ?? 15_000)
    }
  }
}

export function runTurn(agent: BobPiAgent, request: AgentRunRequest): Promise<AgentRunResult> {
  return agent.runTurn(request)
}

export function getAuthStatus(agent: BobPiAgent): Promise<AuthStatus> {
  return agent.getAuthStatus()
}

export function startDeviceLogin(agent: BobPiAgent): Promise<DeviceLoginEvent> {
  return agent.startDeviceLogin()
}
