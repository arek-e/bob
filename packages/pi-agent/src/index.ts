import type {
  AgentAuthStatus,
  AgentRunRequest,
  AgentRunResult,
  DeviceLoginEvent,
  DeviceLoginState
} from "@bob/contracts/agent"
import type { ToolCommand, ToolResult } from "@bob/contracts/tools"

import { featureForToolName, featureForTools } from "@bob/observability/attribution"
import {
  annotateModelUsage,
  recordDecision,
  withBobSpan,
  type BobTurnPhase
} from "@bob/observability/effect"
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
import { Cause, Effect } from "effect"

import { waitForDeviceLoginStart } from "./device-login.ts"
import { classifyProviderError } from "./errors.ts"
import { renderRepairPrompt, renderSystemPrompt } from "./prompt.ts"
import {
  deterministicToolResultFallback,
  noSupportedRecordFallback,
  requiresPersonalGrounding,
  toolResultConfirmsAction,
  trustedToolSourcesFromResult,
  validateAssistantResponse,
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
  readonly executeToolEffect?: (
    command: ToolCommand,
    signal?: AbortSignal
  ) => Effect.Effect<ToolResult, unknown>
  readonly now?: () => number
  readonly deviceLoginStartTimeoutMs?: number
}

export interface BobPiAgent {
  runTurnEffect(request: AgentRunRequest): Effect.Effect<AgentRunResult>
  runTurn(request: AgentRunRequest): Promise<AgentRunResult>
  getAuthStatus(): Promise<AgentAuthStatus>
  getDeviceLoginStatus(): Promise<DeviceLoginState>
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

type ModelLoopResult =
  | { readonly type: "final"; readonly message: AssistantMessage }
  | { readonly type: "timeout" }
  | FailedCompletion

type LoopIteration = ModelLoopResult | { readonly type: "continue" }

class ModelCompletionFailure {
  readonly _tag = "ModelCompletionFailure"

  constructor(readonly completion: Exclude<Completion, { readonly type: "message" }>) {}
}

class ToolInvocationFailure {
  readonly _tag = "ToolInvocationFailure"

  constructor(readonly result: ToolResult) {}
}

class ToolInvocationTimeout {
  readonly _tag = "ToolInvocationTimeout"
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
  let deviceLoginState: DeviceLoginState = { type: "idle" }

  async function readAuthStatus(): Promise<AgentAuthStatus> {
    const credential = await options.credentials.read("openai-codex")
    if (credential?.type !== "oauth") return { configured: false, provider: "openai-codex" }
    const accountId = typeof credential.accountId === "string" ? credential.accountId : undefined
    const expiresAt = new Date(credential.expires).toISOString()
    return {
      configured: credential.expires > now(),
      provider: "openai-codex",
      ...(accountId === undefined
        ? {}
        : { accountIdRedacted: `…${accountId.slice(Math.max(0, accountId.length - 4))}` }),
      expiresAt
    }
  }

  const runTurnEffect = (request: AgentRunRequest): Effect.Effect<AgentRunResult> =>
    Effect.suspend(() => {
      const startedAt = now()
      const controller = new AbortController()
      const turnsLimit = Math.max(1, request.limits.maxTurns)
      const feature = featureForTools(request.allowedTools)
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
      const timeoutEffect = Effect.promise(() => timeoutCompletion)

      const completeModel = (
        turnIndex: number,
        turnPhase: BobTurnPhase
      ): Effect.Effect<Completion> =>
        withBobSpan(
          {
            name: "bob.model.complete",
            correlationId: request.correlationId,
            runId: request.runId,
            feature,
            turnIndex,
            turnPhase
          },
          Effect.gen(function* () {
            const providerCall = Effect.tryPromise({
              try: () =>
                models.completeSimple(model, context, {
                  maxRetries: 0,
                  reasoning: "medium",
                  signal: controller.signal,
                  timeoutMs: Math.max(1, request.limits.maxDurationMs)
                }),
              catch: (error) => error
            }).pipe(
              Effect.map((message) => ({ type: "message" as const, message })),
              Effect.catch((error) => {
                const errorMessage = error instanceof Error ? error.message : undefined
                const errorCode =
                  error instanceof Error && error.name === "AbortError"
                    ? "cancelled"
                    : classifyProviderError(errorMessage)
                return Effect.succeed(failedCompletion(errorMessage, errorCode))
              })
            )
            const completion = yield* Effect.raceFirst(providerCall, timeoutEffect)
            if (completion.type === "message") {
              const completionToolCalls = toolCallsFromAssistant(completion.message).length
              inputTokens += completion.message.usage.input
              outputTokens += completion.message.usage.output
              yield* annotateModelUsage({
                provider: "openai-codex",
                model: options.model,
                inputTokens: completion.message.usage.input,
                outputTokens: completion.message.usage.output,
                toolCallCount: completionToolCalls
              })
              if (completion.message.stopReason === "error") {
                yield* recordDecision({
                  name: "bob.decision.loop",
                  code: "provider_failure",
                  outcome: "denied"
                })
                return yield* Effect.fail(
                  new ModelCompletionFailure(failedCompletion(completion.message.errorMessage))
                )
              }
              if (completion.message.stopReason === "aborted") {
                yield* recordDecision({
                  name: "bob.decision.loop",
                  code: "timeout",
                  outcome: "applied"
                })
                return yield* Effect.fail(
                  new ModelCompletionFailure(
                    failedCompletion(completion.message.errorMessage ?? "aborted", "cancelled")
                  )
                )
              }
            } else if (completion.type === "timeout") {
              yield* recordDecision({
                name: "bob.decision.loop",
                code: "timeout",
                outcome: "applied"
              })
              return yield* Effect.fail(new ModelCompletionFailure(completion))
            } else {
              yield* recordDecision({
                name: "bob.decision.loop",
                code: "provider_failure",
                outcome: "denied"
              })
              return yield* Effect.fail(new ModelCompletionFailure(completion))
            }
            return completion
          })
        ).pipe(
          Effect.catchTag("ModelCompletionFailure", (failure) => Effect.succeed(failure.completion))
        )

      const executeCall = (
        tool: (typeof tools)[number],
        call: ToolCall,
        parameters: unknown
      ): Effect.Effect<
        | {
            readonly type: "completed"
            readonly result: ToolResult
            readonly message: ToolResultMessage<ToolResult>
          }
        | { readonly type: "timeout" }
      > => {
        toolCalls += 1
        executedToolNames.add(call.name)
        const command = {
          runId: request.runId,
          toolCallId: call.id,
          idempotencyKey: `${request.runId}:${call.id}`,
          ownerId: request.ownerId,
          name: tool.label,
          arguments: parameters as ToolCommand["arguments"]
        } as ToolCommand
        const fallbackExecution = Effect.tryPromise({
          try: () => options.executeTool(command, controller.signal),
          catch: (error) => error
        })
        const executeToolEffect = options.executeToolEffect
        const executionEffect =
          executeToolEffect === undefined
            ? fallbackExecution
            : Effect.suspend(() => executeToolEffect(command, controller.signal))
        const completed = (toolResult: ToolResult) => {
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
            type: "completed" as const,
            result: toolResult,
            message: toolResultMessage(call, toolResult, now)
          }
        }
        return withBobSpan(
          {
            name: "bob.tool.invoke",
            correlationId: request.correlationId,
            runId: request.runId,
            feature: featureForToolName(call.name),
            toolName: call.name,
            toolCallIndex: toolCalls
          },
          Effect.gen(function* () {
            const execution = yield* Effect.raceFirst(
              executionEffect.pipe(
                Effect.catchCause((cause) =>
                  Cause.hasInterrupts(cause)
                    ? Effect.interrupt
                    : Effect.gen(function* () {
                        yield* recordDecision({
                          name: "bob.decision.policy",
                          code: "provider_failure",
                          outcome: "denied"
                        })
                        return yield* Effect.fail(new ToolInvocationFailure(safeToolFailure()))
                      })
                ),
                Effect.map((toolResult) => ({ type: "result" as const, result: toolResult }))
              ),
              timeoutEffect
            )
            if (execution.type === "timeout") {
              return yield* Effect.fail(new ToolInvocationTimeout())
            }
            return completed(execution.result)
          })
        ).pipe(
          Effect.catchTag("ToolInvocationFailure", (failure) =>
            Effect.succeed(completed(failure.result))
          ),
          Effect.catchTag("ToolInvocationTimeout", () =>
            Effect.succeed({ type: "timeout" as const })
          )
        )
      }

      const runPrimaryTurn = (): Effect.Effect<LoopIteration> => {
        if (turns >= turnsLimit) {
          return Effect.gen(function* () {
            yield* recordDecision({
              name: "bob.decision.loop",
              code: "turn_limit",
              outcome: "denied"
            })
            return failedCompletion("Turn limit reached.")
          })
        }
        turns += 1
        const turnIndex = turns
        return withBobSpan(
          {
            name: "bob.agent.turn",
            correlationId: request.correlationId,
            runId: request.runId,
            feature,
            turnIndex,
            turnPhase: "primary"
          },
          Effect.gen(function* () {
            const completion = yield* completeModel(turnIndex, "primary")
            if (completion.type === "timeout") {
              yield* recordDecision({
                name: "bob.decision.loop",
                code: "timeout",
                outcome: "applied"
              })
              return completion
            }
            if (completion.type === "failed") {
              yield* recordDecision({
                name: "bob.decision.loop",
                code: "provider_failure",
                outcome: "denied"
              })
              return completion
            }
            const assistant = completion.message
            context.messages.push(assistant)
            if (assistant.stopReason === "aborted") {
              yield* recordDecision({
                name: "bob.decision.loop",
                code: "timeout",
                outcome: "applied"
              })
              return failedCompletion(assistant.errorMessage ?? "aborted", "cancelled")
            }
            if (assistant.stopReason === "error") {
              yield* recordDecision({
                name: "bob.decision.loop",
                code: "provider_failure",
                outcome: "denied"
              })
              return failedCompletion(assistant.errorMessage)
            }

            const calls = toolCallsFromAssistant(assistant)
            if (calls.length === 0) {
              yield* recordDecision({
                name: "bob.decision.loop",
                code: "final",
                outcome: "selected"
              })
              return { type: "final" as const, message: assistant }
            }
            yield* recordDecision({
              name: "bob.decision.loop",
              code: "tool_calls",
              outcome: "selected",
              selectedCount: calls.length
            })

            for (const call of calls) {
              const allowlisted = request.allowedTools.some((name) => name === call.name)
              const tool = toolsByName.get(call.name)
              if (!allowlisted || tool === undefined) {
                yield* recordDecision({
                  name: "bob.decision.tool_gate",
                  code: allowlisted ? "not_registered" : "not_allowlisted",
                  outcome: "denied"
                })
                toolResults.push(safeToolFailure())
                return {
                  type: "failed" as const,
                  errorMessage: "Tool is not allowed for this run."
                }
              }
              if (toolCalls >= request.limits.maxToolCalls) {
                yield* recordDecision({
                  name: "bob.decision.tool_gate",
                  code: "limit",
                  outcome: "denied"
                })
                toolResults.push(safeToolFailure())
                return { type: "failed" as const, errorMessage: "Tool-call limit reached." }
              }

              let parameters: unknown
              try {
                parameters = validateToolCall(modelTools, call)
              } catch {
                yield* recordDecision({
                  name: "bob.decision.tool_gate",
                  code: "arguments_invalid",
                  outcome: "denied"
                })
                return failedCompletion("Tool arguments failed validation.", "invalid_output")
              }
              yield* recordDecision({
                name: "bob.decision.tool_gate",
                code: "allowed",
                outcome: "allowed"
              })
              const execution = yield* executeCall(tool, call, parameters)
              if (execution.type === "timeout") return execution
              context.messages.push(execution.message)
              if (!execution.result.ok) {
                yield* recordDecision({
                  name: "bob.decision.policy",
                  code: "provider_failure",
                  outcome: "denied"
                })
                return {
                  type: "failed" as const,
                  errorMessage: "The tool could not complete safely."
                }
              }
            }
            return { type: "continue" as const }
          })
        )
      }

      const runModelLoop = (): Effect.Effect<ModelLoopResult> =>
        Effect.suspend(() =>
          runPrimaryTurn().pipe(
            Effect.flatMap((iteration) =>
              iteration.type === "continue" ? runModelLoop() : Effect.succeed(iteration)
            )
          )
        )

      const responsePolicy = {
        maxResponseCharacters: request.limits.maxResponseCharacters,
        approvedSourceIds,
        requiresSource: needsPersonalGrounding,
        conflictingSourceIds,
        executedToolNames,
        confirmedActionToolNames
      }

      const validateOutput = (raw: string) =>
        withBobSpan(
          {
            name: "bob.output.validate",
            correlationId: request.correlationId,
            runId: request.runId,
            feature
          },
          Effect.gen(function* () {
            const validation = validateAssistantResponse(raw, responsePolicy)
            yield* recordDecision({
              name: "bob.decision.output",
              code: validation.ok ? "valid_output" : "repair_required",
              outcome: validation.ok ? "allowed" : "selected"
            })
            return validation
          })
        )

      const completeResult = (
        value: Extract<ReturnType<typeof validateAssistantResponse>, { readonly ok: true }>["value"]
      ): AgentRunResult => ({
        ...result("completed", value.responseText, undefined),
        sourceIds: value.sourceIds,
        ...(trustedToolSources.size === 0
          ? {}
          : { trustedToolSources: [...trustedToolSources.values()].slice(0, 24) }),
        conflict: value.conflict
      })

      const validateAndRepair = (message: AssistantMessage): Effect.Effect<AgentRunResult> =>
        Effect.gen(function* () {
          const initial = yield* validateOutput(contentText(message.content).trim())
          if (initial.ok) return completeResult(initial.value)
          if (turns >= turnsLimit || controller.signal.aborted) {
            yield* recordDecision({
              name: "bob.decision.output",
              code: "invalid_output",
              outcome: "denied"
            })
            return result(
              "failed",
              deterministicToolResultFallback(toolResults, request.limits.maxResponseCharacters),
              "invalid_output"
            )
          }

          return yield* withBobSpan(
            {
              name: "bob.output.repair",
              correlationId: request.correlationId,
              runId: request.runId,
              feature
            },
            Effect.gen(function* () {
              yield* recordDecision({
                name: "bob.decision.output",
                code: "repair_required",
                outcome: "applied"
              })
              context.tools = []
              const repairMessage: Message = {
                role: "user",
                content: renderRepairPrompt(initial.code),
                timestamp: now()
              }
              context.messages.push(repairMessage)
              turns += 1
              const repairTurn = turns
              const completion = yield* withBobSpan(
                {
                  name: "bob.agent.turn",
                  correlationId: request.correlationId,
                  runId: request.runId,
                  feature,
                  turnIndex: repairTurn,
                  turnPhase: "repair"
                },
                completeModel(repairTurn, "repair")
              )
              if (completion.type === "timeout" || timedOut) {
                yield* recordDecision({
                  name: "bob.decision.output",
                  code: "timeout",
                  outcome: "denied"
                })
                return result(
                  "cancelled",
                  deterministicToolResultFallback(
                    toolResults,
                    request.limits.maxResponseCharacters
                  ),
                  "timeout"
                )
              }
              if (
                completion.type !== "message" ||
                completion.message.stopReason === "error" ||
                completion.message.stopReason === "aborted" ||
                toolCallsFromAssistant(completion.message).length > 0
              ) {
                yield* recordDecision({
                  name: "bob.decision.output",
                  code: "repair_failed",
                  outcome: "denied"
                })
                return result(
                  "failed",
                  deterministicToolResultFallback(
                    toolResults,
                    request.limits.maxResponseCharacters
                  ),
                  "invalid_output"
                )
              }
              context.messages.push(completion.message)
              const repaired = yield* validateOutput(contentText(completion.message.content).trim())
              if (!repaired.ok) {
                yield* recordDecision({
                  name: "bob.decision.output",
                  code: "repair_failed",
                  outcome: "denied"
                })
                return result(
                  "failed",
                  deterministicToolResultFallback(
                    toolResults,
                    request.limits.maxResponseCharacters
                  ),
                  "invalid_output"
                )
              }
              yield* recordDecision({
                name: "bob.decision.output",
                code: "repair_succeeded",
                outcome: "applied"
              })
              return completeResult(repaired.value)
            })
          )
        })

      const loopProgram = Effect.gen(function* () {
        yield* recordDecision({
          name: "bob.decision.toolset",
          code: "agent_turn",
          outcome: "selected",
          selectedCount: modelTools.length
        })
        for (const tool of modelTools) {
          yield* recordDecision({
            name: "bob.decision.toolset",
            code: "allowed",
            outcome: "selected",
            toolName: tool.name
          })
        }
        const loop = yield* runModelLoop()
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
        if (!needsPersonalGrounding) {
          yield* recordDecision({
            name: "bob.decision.grounding",
            code: "grounding_not_required",
            outcome: "skipped"
          })
        } else if (approvedSourceIds.size === 0) {
          yield* recordDecision({
            name: "bob.decision.grounding",
            code: "grounding_missing",
            outcome: "denied"
          })
          return result("failed", noSupportedRecordFallback(request.locale), "policy")
        } else {
          yield* recordDecision({
            name: "bob.decision.grounding",
            code: "grounding_present",
            outcome: "allowed",
            selectedCount: approvedSourceIds.size
          })
        }
        return yield* validateAndRepair(loop.message)
      })

      return withBobSpan(
        {
          name: "bob.agent.loop",
          correlationId: request.correlationId,
          runId: request.runId,
          feature
        },
        loopProgram
      ).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            if (timeout !== undefined) clearTimeout(timeout)
          })
        )
      )
    })

  return {
    runTurnEffect,
    runTurn: (request) => Effect.runPromise(runTurnEffect(request)),

    getAuthStatus: readAuthStatus,

    async getDeviceLoginStatus() {
      return deviceLoginState
    },

    async startDeviceLogin() {
      if (activeLogin !== undefined) {
        return deviceLoginState.type === "device_code"
          ? deviceLoginState
          : { type: "failed", code: "login_already_active" }
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
            deviceLoginState = {
              type: "device_code",
              verificationUri: event.verificationUri,
              userCode: event.userCode,
              expiresAt: new Date(now() + (event.expiresInSeconds ?? 900) * 1_000).toISOString()
            }
            resolveEvent(deviceLoginState)
          }
        }
      }
      activeLogin = models
        .login("openai-codex", "oauth", interaction)
        .then(async () => {
          const status = await readAuthStatus()
          deviceLoginState =
            status.configured && status.expiresAt !== undefined
              ? {
                  type: "completed",
                  ...(status.accountIdRedacted === undefined
                    ? {}
                    : { accountIdRedacted: status.accountIdRedacted }),
                  expiresAt: status.expiresAt
                }
              : { type: "failed", code: "credential_not_saved" }
        })
        .catch(() => {
          deviceLoginState = { type: "failed", code: "device_login_failed" }
          if (!eventSent) resolveEvent(deviceLoginState)
        })
        .finally(() => {
          activeLogin = undefined
        })
      const started = await waitForDeviceLoginStart(
        firstEvent,
        options.deviceLoginStartTimeoutMs ?? 15_000
      )
      if (started.type === "failed" && !eventSent) deviceLoginState = started
      return started
    }
  }
}

export function runTurn(agent: BobPiAgent, request: AgentRunRequest): Promise<AgentRunResult> {
  return agent.runTurn(request)
}

export function getAuthStatus(agent: BobPiAgent): Promise<AgentAuthStatus> {
  return agent.getAuthStatus()
}

export function getDeviceLoginStatus(agent: BobPiAgent): Promise<DeviceLoginState> {
  return agent.getDeviceLoginStatus()
}

export function startDeviceLogin(agent: BobPiAgent): Promise<DeviceLoginEvent> {
  return agent.startDeviceLogin()
}
