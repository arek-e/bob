import {
  AgentCheckpointError,
  AgentConfigurationError,
  AgentProviderError,
  AgentToolError,
  BobAgent,
  type AgentRunDurability,
  type BobAgentService,
  type CredentialStore
} from "@bob/agent-types"
import {
  AgentRunOperation as AgentRunOperationSchema,
  AgentRunResult as AgentRunResultSchema,
  type AgentRunOperation,
  type AgentRunRequest,
  type AgentRunResult,
  type AgentSmokeResult,
  type AgentSteerResult,
  type DeviceLoginEvent
} from "@bob/agent-types/run"
import {
  featureForToolName,
  featureForTools,
  annotateModelUsage,
  injectCurrentTraceparent,
  recordDecision,
  withBobSpan,
  type BobDecision,
  type BobTurnPhase
} from "@bob/observability"
import {
  ToolResult as ToolResultSchema,
  type CapabilityCatalogue,
  type ToolCommand,
  type ToolName,
  type ToolResult
} from "@bob/tools-types/tools"
import {
  contentText,
  createModels,
  validateToolCall,
  type AuthEvent,
  type AuthInteraction,
  type AssistantMessage,
  type Context,
  type Message,
  type ModelsSimpleStreamOptions,
  type Tool,
  type ToolCall,
  type ToolResultMessage,
  type UserMessage
} from "@earendil-works/pi-ai"
import { registerBunOAuthFlows } from "@earendil-works/pi-ai/bun-oauth"
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai"
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex"
import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter"
import { Cause, Data, Deferred, Effect, Fiber, Layer, Schema } from "effect"

import { classifyProviderError } from "../errors.ts"
import { renderRepairPrompt, renderSystemPrompt } from "../prompt.ts"
import {
  deterministicToolResultFallback,
  noSupportedRecordFallback,
  toolResultConfirmsAction,
  trustedToolSourcesFromResult,
  validateAssistantResponse,
  type TrustedToolSource
} from "../response-safety.ts"
import { createTools, toolCommandForCall } from "../tools.ts"
import { waitForDeviceLoginStart } from "./device-login.ts"

const pendingSteerRetentionMs = 140_000

const PiAgentConfiguration = Schema.Struct({
  provider: Schema.Literals(["openai-codex", "openrouter", "litellm"]),
  model: Schema.NonEmptyString,
  allowedModels: Schema.Array(Schema.NonEmptyString).check(Schema.isNonEmpty())
})

export interface PiAgentOptions {
  readonly catalogue: CapabilityCatalogue
  readonly credentials: CredentialStore
  readonly provider: "openai-codex" | "openrouter" | "litellm"
  readonly model: string
  readonly allowedModels: readonly string[]
  readonly gateway?: {
    readonly baseUrl: string
    readonly apiKey: string
  }
  readonly executeTool: (command: ToolCommand) => Effect.Effect<ToolResult, AgentToolError>
  readonly loadAttachment?: (
    runId: string,
    attachment: NonNullable<
      NonNullable<AgentRunRequest["currentTurnMessages"]>[number]["attachments"]
    >[number]
  ) => Effect.Effect<{ readonly data: string; readonly mimeType: string }, AgentProviderError>
  readonly now?: () => number
  readonly deviceLoginStartTimeoutMs?: number
  readonly dependencies?: PiAgentDependencies
}

export type PiAgentLayerOptions = Omit<PiAgentOptions, "dependencies">

export interface PiAgentDependencies {
  readonly createModels: (options: {
    readonly credentials: CredentialStore
  }) => Pick<
    ReturnType<typeof createModels>,
    "setProvider" | "getModel" | "completeSimple" | "login"
  >
  readonly openaiCodexProvider: typeof openaiCodexProvider
  readonly openaiProvider?: typeof openaiProvider
  readonly openrouterProvider: typeof openrouterProvider
  readonly registerOAuthFlows: typeof registerBunOAuthFlows
}

function registerDefaultOAuthFlows(): void {
  registerBunOAuthFlows()
}

const defaultDependencies: PiAgentDependencies = {
  createModels,
  openaiCodexProvider,
  openaiProvider,
  openrouterProvider,
  registerOAuthFlows: registerDefaultOAuthFlows
}

export interface AuthStatus {
  readonly configured: boolean
  readonly provider: "openai-codex" | "openrouter" | "litellm"
  readonly accountIdRedacted?: string
  readonly expiresAt?: string
}

export interface PiAgentRuntime {
  runTurnEffect(
    request: AgentRunRequest,
    signal?: AbortSignal,
    durability?: AgentRunDurability
  ): Effect.Effect<AgentRunResult, AgentCheckpointError>
  runSmoke(): Effect.Effect<AgentSmokeResult>
  requestSteer(runId: AgentRunRequest["runId"]): AgentSteerResult
  getAuthStatus(): Effect.Effect<AuthStatus, AgentProviderError>
  startDeviceLogin(): Effect.Effect<DeviceLoginEvent>
  dispose(): void
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

interface ActiveModelCall {
  readonly cancel: () => void
}

interface ActiveToolCall {
  readonly readOnly: boolean
  readonly cancel: () => void
}

interface ActiveRunState {
  steerRequested: boolean
  phase: "checkpoint" | "model" | "tool"
  modelCall?: ActiveModelCall
  toolCall?: ActiveToolCall
}

interface ReplayContinuation {
  readonly assistant: AssistantMessage
  readonly turnIndex: number
  readonly turnPhase: BobTurnPhase
  readonly completed: ReadonlyMap<string, ToolResult>
}

type ReplayState =
  | { readonly type: "initial" }
  | {
      readonly type: "awaiting_tools"
      readonly continuation: ReplayContinuation
      readonly calls: readonly ToolCall[]
      readonly nextToolIndex: number
    }
  | {
      readonly type: "awaiting_model"
      readonly continuation: ReplayContinuation
    }
  | { readonly type: "final"; readonly result: AgentRunResult }

const CheckpointTextContent = Schema.Struct({
  type: Schema.Literal("text"),
  text: Schema.String,
  textSignature: Schema.optionalKey(Schema.String)
})

const CheckpointThinkingContent = Schema.Struct({
  type: Schema.Literal("thinking"),
  thinking: Schema.String,
  thinkingSignature: Schema.optionalKey(Schema.String),
  redacted: Schema.optionalKey(Schema.Boolean)
})

const CheckpointToolCall = Schema.Struct({
  type: Schema.Literal("toolCall"),
  id: Schema.String,
  name: Schema.String,
  arguments: Schema.Record(Schema.String, Schema.Json),
  thoughtSignature: Schema.optionalKey(Schema.String)
})

const CheckpointUsage = Schema.Struct({
  input: Schema.Number,
  output: Schema.Number,
  cacheRead: Schema.Number,
  cacheWrite: Schema.Number,
  cacheWrite1h: Schema.optionalKey(Schema.Number),
  reasoning: Schema.optionalKey(Schema.Number),
  totalTokens: Schema.Number,
  cost: Schema.Struct({
    input: Schema.Number,
    output: Schema.Number,
    cacheRead: Schema.Number,
    cacheWrite: Schema.Number,
    total: Schema.Number
  })
})

const CheckpointAssistantMessage = Schema.Struct({
  role: Schema.Literal("assistant"),
  content: Schema.Array(
    Schema.Union([CheckpointTextContent, CheckpointThinkingContent, CheckpointToolCall])
  ),
  api: Schema.String,
  provider: Schema.String,
  model: Schema.String,
  responseModel: Schema.optionalKey(Schema.String),
  responseId: Schema.optionalKey(Schema.String),
  usage: CheckpointUsage,
  stopReason: Schema.Literals([
    "pending",
    "stop",
    "length",
    "toolUse",
    "error",
    "aborted",
    "deferred"
  ]),
  deferred: Schema.optionalKey(
    Schema.Struct({
      provider: Schema.String,
      modelId: Schema.String,
      api: Schema.String,
      id: Schema.String,
      expiresAt: Schema.optionalKey(Schema.Number),
      pollAfterMs: Schema.optionalKey(Schema.Number),
      data: Schema.optionalKey(Schema.Json)
    })
  ),
  errorMessage: Schema.optionalKey(Schema.String),
  rawStopReason: Schema.optionalKey(Schema.String),
  timestamp: Schema.Number
})

const ModelOperationPayload = Schema.Struct({
  turnIndex: Schema.Int,
  turnPhase: Schema.Literals(["primary", "repair"]),
  message: CheckpointAssistantMessage
})

const ToolOperationPayload = Schema.Struct({
  turnIndex: Schema.Int,
  toolCallIndex: Schema.Int,
  toolCallId: Schema.String,
  result: ToolResultSchema,
  timestamp: Schema.Number
})

function jsonValue<Value>(value: Value): typeof Schema.Json.Type {
  return Schema.decodeUnknownSync(Schema.Json)(JSON.parse(JSON.stringify(value)))
}

function checkpointAssistantMessage(message: AssistantMessage): typeof Schema.Json.Type {
  const content: AssistantMessage["content"] = []
  for (const block of message.content) {
    if (block.type !== "thinking") content.push(block)
    else if (block.thinkingSignature !== undefined) {
      content.push({ ...block, thinking: "", redacted: true })
    }
  }
  const { diagnostics: _diagnostics, ...safeMessage } = message
  return jsonValue({ ...safeMessage, content })
}

function mutableAssistantMessage(
  message: typeof CheckpointAssistantMessage.Type
): AssistantMessage {
  const { deferred, ...messageWithoutDeferred } = message
  const common = {
    ...messageWithoutDeferred,
    content: message.content.map((block) =>
      block.type === "toolCall" ? { ...block, arguments: { ...block.arguments } } : { ...block }
    )
  }
  if (deferred === undefined) return common
  const { data, ...deferredWithoutData } = deferred
  if (data === undefined) return { ...common, deferred: deferredWithoutData }
  return {
    ...common,
    deferred: { ...deferredWithoutData, data: JSON.parse(JSON.stringify(data)) }
  }
}

class ModelCompletionFailure extends Data.TaggedError("ModelCompletionFailure")<{
  readonly completion: Exclude<Completion, { readonly type: "message" }>
}> {}

class ToolInvocationFailure extends Data.TaggedError("ToolInvocationFailure")<{
  readonly result: ToolResult
}> {}

class ToolInvocationTimeout extends Data.TaggedError("ToolInvocationTimeout") {}

function failedCompletion(
  errorMessage: string | undefined,
  errorCode?: AgentRunResult["errorCode"]
): FailedCompletion {
  const completion: FailedCompletion = { type: "failed" }
  if (errorMessage !== undefined) Object.assign(completion, { errorMessage })
  if (errorCode !== undefined) Object.assign(completion, { errorCode })
  return completion
}

function safeToolFailure(): ToolResult {
  return {
    ok: false,
    code: "tool_execution_failed",
    message: "The tool could not complete safely."
  }
}

const reflectedToolResultCodes = new Set([
  "choice_required",
  "confirmation_required",
  "external_outcome_unknown"
])

/** These domain results need an owner-facing reply, not a generic agent failure. */
export function toolResultNeedsReflection(result: ToolResult): boolean {
  return !result.ok && reflectedToolResultCodes.has(result.code)
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

const TextSignature = Schema.Struct({
  v: Schema.Literal(1),
  id: Schema.String,
  phase: Schema.Literals(["commentary", "final_answer"])
})

function textPhase(signature: string | undefined): "commentary" | "final_answer" | undefined {
  if (signature === undefined || !signature.startsWith("{")) return undefined
  try {
    return Schema.decodeUnknownSync(TextSignature)(JSON.parse(signature)).phase
  } catch {
    return undefined
  }
}

function structuredOutputText(message: AssistantMessage): string {
  const textBlocks = message.content.flatMap((block) =>
    block.type === "text" ? [{ block, phase: textPhase(block.textSignature) }] : []
  )
  const finalAnswers = textBlocks.filter(({ phase }) => phase === "final_answer")
  if (finalAnswers.length > 0) {
    return finalAnswers
      .map(({ block }) => block.text)
      .join("\n")
      .trim()
  }
  const unphased = textBlocks.filter(({ phase }) => phase === undefined)
  if (unphased.length === textBlocks.length) {
    return contentText(message.content).trim()
  }
  return unphased
    .map(({ block }) => block.text)
    .join("\n")
    .trim()
}

export function createPiAgent(options: PiAgentOptions): PiAgentRuntime {
  const configuration = Schema.decodeUnknownSync(PiAgentConfiguration)(options)
  if (!configuration.allowedModels.includes(configuration.model))
    throw new AgentConfigurationError({ message: "Configured model is not allowlisted" })

  const dependencies = options.dependencies ?? defaultDependencies
  dependencies.registerOAuthFlows()
  const models = dependencies.createModels({ credentials: options.credentials })
  const gatewayProvider = () => {
    const gateway = options.gateway
    if (gateway === undefined)
      throw new AgentConfigurationError({
        message: "LiteLLM gateway configuration is required"
      })
    const upstream = (dependencies.openaiProvider ?? openaiProvider)()
    const gatewayModels = upstream.getModels().map((model) => ({
      ...model,
      provider: "litellm",
      baseUrl: gateway.baseUrl
    }))
    return {
      ...upstream,
      id: "litellm",
      name: "LiteLLM",
      baseUrl: gateway.baseUrl,
      auth: {
        apiKey: {
          name: "LiteLLM virtual key",
          async resolve() {
            return { auth: { apiKey: gateway.apiKey }, source: "BOB_GATEWAY_API_KEY" }
          }
        }
      },
      getModels: () => gatewayModels
    }
  }
  const providerAdapters = {
    "openai-codex": dependencies.openaiCodexProvider,
    openrouter: dependencies.openrouterProvider,
    litellm: gatewayProvider
  }
  models.setProvider(providerAdapters[options.provider]())
  const model = models.getModel(options.provider, options.model)
  if (model === undefined)
    throw new AgentConfigurationError({
      message: "Configured model is unavailable in the pinned Pi catalog"
    })

  const now = options.now ?? Date.now
  let activeLogin: Promise<unknown> | undefined
  const activeRuns = new Map<AgentRunRequest["runId"], ActiveRunState>()
  const pendingSteers = new Map<AgentRunRequest["runId"], number>()

  const runTurnEffect = (
    request: AgentRunRequest,
    externalSignal?: AbortSignal,
    durability?: AgentRunDurability
  ): Effect.Effect<AgentRunResult, AgentCheckpointError> =>
    Effect.try({
      try: () => {
        const startedAt = now()
        const activeRun: ActiveRunState = { steerRequested: false, phase: "checkpoint" }
        activeRuns.set(request.runId, activeRun)
        const pendingSteer = pendingSteers.get(request.runId)
        if (pendingSteer !== undefined) {
          pendingSteers.delete(request.runId)
          activeRun.steerRequested = pendingSteer >= now()
        }
        const cancellationRequested = () =>
          externalSignal?.aborted === true || timedOut || activeRun.steerRequested
        const externalCancellation = Deferred.makeUnsafe<FailedCompletion>()
        const resolveExternalCancellation = (completion: FailedCompletion) => {
          Deferred.doneUnsafe(externalCancellation, Effect.succeed(completion))
        }
        const abortFromCaller = () => {
          resolveExternalCancellation(failedCompletion("aborted", "cancelled"))
        }
        if (externalSignal?.aborted === true) abortFromCaller()
        else externalSignal?.addEventListener("abort", abortFromCaller, { once: true })
        const turnsLimit = Math.max(1, request.limits.maxTurns)
        const feature = featureForTools(options.catalogue, request.allowedTools)
        let turns = 0
        let toolCalls = 0
        let inputTokens = 0
        let outputTokens = 0
        let timedOut = false
        const toolResults: ToolResult[] = []
        const executedToolNames = new Set<string>()
        const confirmedActionToolNames = new Set<string>()
        const proposedActionToolNames = new Set<string>()
        const unknownActionToolNames = new Set<ToolName>()
        for (const receipt of request.priorToolReceipts ?? []) {
          if (receipt.actionOutcome === "unknown") {
            unknownActionToolNames.add(receipt.toolName)
            continue
          }
          if (receipt.origin === "same_turn" && receipt.actionOutcome === "confirmed") {
            confirmedActionToolNames.add(receipt.toolName)
          }
          if (receipt.origin === "same_turn" && receipt.actionOutcome === "proposed") {
            proposedActionToolNames.add(receipt.toolName)
          }
        }
        const approvedSourceIds = new Set(
          request.contextItems.flatMap((item) => item.sources.map((source) => source.sourceId))
        )
        const conflictingSourceIds = new Set(
          request.contextItems
            .filter((item) => item.conflict)
            .flatMap((item) => item.sources.map((source) => source.sourceId))
        )
        const trustedToolSources = new Map<string, TrustedToolSource>()
        const currentTurnMessages = request.currentTurnMessages ?? [
          {
            sourceMessageId: request.sourceMessageId,
            text: request.userText,
            attachments: undefined
          }
        ]
        const needsPersonalGrounding = request.grounding?.requiresSources === true
        const storedOperations = durability?.operations ?? []
        let operationSequence = 0
        for (const operation of storedOperations) {
          if (operation.runId !== request.runId || operation.sequence !== operationSequence + 1) {
            throw new AgentCheckpointError({
              message: "Stored Agent run operations are not contiguous"
            })
          }
          operationSequence = operation.sequence
        }

        const result = (
          status: AgentRunResult["status"],
          responseText: string | undefined,
          errorCode: AgentRunResult["errorCode"] | undefined
        ): AgentRunResult => {
          const output: AgentRunResult = {
            protocolVersion: 1,
            runId: request.runId,
            correlationId: request.correlationId,
            status,
            model: options.model,
            durationMs: Math.max(0, now() - startedAt),
            inputTokens,
            outputTokens,
            toolCalls
          }
          if (responseText !== undefined) Object.assign(output, { responseText })
          if (errorCode !== undefined) Object.assign(output, { errorCode })
          return output
        }

        const tools = createTools({
          catalogue: options.catalogue,
          request
        })
        const modelTools: Tool[] = tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters
        }))
        const toolsByName = new Map(tools.map((tool) => [tool.name, tool]))
        const context: Context = {
          systemPrompt: renderSystemPrompt(request),
          messages: currentTurnMessages.map((message) => ({
            role: "user" as const,
            content: message.text,
            timestamp: now()
          })),
          tools: modelTools
        }
        const prepareContext = Effect.forEach(currentTurnMessages, (message) => {
          const attachments = message.attachments ?? []
          if (attachments.length === 0) {
            return Effect.succeed({
              role: "user" as const,
              content: message.text,
              timestamp: now()
            })
          }
          if (!model.input.includes("image") || options.loadAttachment === undefined) {
            return Effect.fail(
              new AgentProviderError({
                code: "provider",
                message: "Configured Agent runtime cannot load image attachments"
              })
            )
          }
          return Effect.forEach(attachments, (attachment) =>
            options.loadAttachment!(request.runId, attachment)
          ).pipe(
            Effect.map((images): UserMessage => ({
              role: "user",
              content: [
                ...(message.text.length === 0
                  ? []
                  : [{ type: "text" as const, text: message.text }]),
                ...images.map((image) => ({
                  type: "image" as const,
                  data: image.data,
                  mimeType: image.mimeType
                }))
              ],
              timestamp: now()
            }))
          )
        }).pipe(
          Effect.map((messages) => {
            context.messages = messages
            return true
          }),
          Effect.catch(() => Effect.succeed(false))
        )

        const appendOperation = (
          kind: AgentRunOperation["kind"],
          payload: typeof Schema.Json.Type
        ): Effect.Effect<boolean> => {
          if (durability === undefined) return Effect.succeed(true)
          const operation = Schema.decodeUnknownSync(AgentRunOperationSchema)({
            protocolVersion: 1,
            loopVersion: 1,
            runId: request.runId,
            sequence: operationSequence + 1,
            kind,
            payload
          })
          return durability.append(operation).pipe(
            Effect.map(() => {
              operationSequence = operation.sequence
              return true
            }),
            Effect.catch(() => Effect.succeed(false))
          )
        }

        let timeoutEffect: Effect.Effect<{ readonly type: "timeout" }> = Effect.never
        const externalCancellationEffect = Deferred.await(externalCancellation)

        const completeModel = (
          turnIndex: number,
          turnPhase: BobTurnPhase
        ): Effect.Effect<Completion> =>
          Effect.suspend(() => {
            const modelCall: ActiveModelCall = {
              cancel: () => {
                resolveExternalCancellation(failedCompletion("aborted", "cancelled"))
              }
            }
            activeRun.modelCall = modelCall
            activeRun.phase = "model"
            return withBobSpan(
              {
                name: "bob.model.complete",
                correlationId: request.correlationId,
                runId: request.runId,
                feature,
                turnIndex,
                turnPhase
              },
              Effect.gen(function* () {
                const headers =
                  options.provider === "litellm"
                    ? Object.fromEntries((yield* injectCurrentTraceparent()).entries())
                    : undefined
                const providerCall = Effect.tryPromise({
                  try: (signal) => {
                    const requestOptions: ModelsSimpleStreamOptions = {
                      maxRetries: 0,
                      reasoning: "medium",
                      signal:
                        externalSignal === undefined
                          ? signal
                          : AbortSignal.any([externalSignal, signal]),
                      timeoutMs: Math.max(1, request.limits.maxDurationMs)
                    }
                    if (headers !== undefined) requestOptions.headers = headers
                    return models.completeSimple(model, context, requestOptions)
                  },
                  catch: (cause) => {
                    const message = cause instanceof Error ? cause.message : "Model request failed"
                    const classified =
                      cause instanceof Error && cause.name === "AbortError"
                        ? "cancelled"
                        : classifyProviderError(message)
                    return new AgentProviderError({
                      code:
                        classified === "policy" || classified === "invalid_output"
                          ? "provider"
                          : classified,
                      message,
                      cause
                    })
                  }
                }).pipe(
                  Effect.map((message) => ({ type: "message" as const, message })),
                  Effect.catch((error) => {
                    return Effect.succeed(failedCompletion(error.message, error.code))
                  })
                )
                const completion = yield* Effect.raceFirst(
                  Effect.raceFirst(providerCall, timeoutEffect),
                  externalCancellationEffect
                )
                if (completion.type === "message") {
                  const completionToolCalls = toolCallsFromAssistant(completion.message).length
                  inputTokens += completion.message.usage.input
                  outputTokens += completion.message.usage.output
                  yield* annotateModelUsage({
                    provider: options.provider,
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
                      new ModelCompletionFailure({
                        completion: failedCompletion(completion.message.errorMessage)
                      })
                    )
                  }
                  if (completion.message.stopReason === "aborted") {
                    yield* recordDecision({
                      name: "bob.decision.loop",
                      code: "timeout",
                      outcome: "applied"
                    })
                    return yield* Effect.fail(
                      new ModelCompletionFailure({
                        completion: failedCompletion(
                          completion.message.errorMessage ?? "aborted",
                          "cancelled"
                        )
                      })
                    )
                  }
                } else if (completion.type === "timeout") {
                  yield* recordDecision({
                    name: "bob.decision.loop",
                    code: "timeout",
                    outcome: "applied"
                  })
                  return yield* Effect.fail(new ModelCompletionFailure({ completion }))
                } else {
                  yield* recordDecision({
                    name: "bob.decision.loop",
                    code: "provider_failure",
                    outcome: "denied"
                  })
                  return yield* Effect.fail(new ModelCompletionFailure({ completion }))
                }
                return completion
              })
            ).pipe(
              Effect.catchTag("ModelCompletionFailure", (failure) =>
                Effect.succeed(failure.completion)
              ),
              Effect.ensuring(
                Effect.sync(() => {
                  if (activeRun.modelCall === modelCall) {
                    delete activeRun.modelCall
                    activeRun.phase = "checkpoint"
                  }
                })
              )
            )
          })

        const recordCompletedToolResult = (toolName: string, toolResult: ToolResult): void => {
          toolResults.push(toolResult)
          for (const source of trustedToolSourcesFromResult(toolResult)) {
            if (!trustedToolSources.has(source.sourceId) && trustedToolSources.size >= 24) continue
            trustedToolSources.set(source.sourceId, source)
            approvedSourceIds.add(source.sourceId)
          }
          if (toolResultConfirmsAction(toolResult)) {
            confirmedActionToolNames.add(toolName)
          }
          if (toolResult.evidence?.actionOutcome === "proposed") {
            proposedActionToolNames.add(toolName)
          }
          if (toolResult.evidence?.actionOutcome === "unknown") {
            unknownActionToolNames.add(toolName)
          }
        }

        const executeCall = (
          tool: (typeof tools)[number],
          call: ToolCall,
          command: ToolCommand
        ): Effect.Effect<
          | {
              readonly type: "completed"
              readonly result: ToolResult
              readonly message: ToolResultMessage<ToolResult>
            }
          | { readonly type: "timeout" }
          | FailedCompletion
        > => {
          if (cancellationRequested()) {
            return Effect.succeed(failedCompletion("aborted", "cancelled"))
          }
          toolCalls += 1
          executedToolNames.add(call.name)
          const readOnly = options.catalogue.isReadOnly(command.name)
          const activeToolCall: ActiveToolCall = {
            readOnly,
            cancel: () => resolveExternalCancellation(failedCompletion("aborted", "cancelled"))
          }
          const executionEffect = Effect.suspend(() => options.executeTool(command))
          const completed = (toolResult: ToolResult) => {
            recordCompletedToolResult(call.name, toolResult)
            return {
              type: "completed" as const,
              result: toolResult,
              message: toolResultMessage(call, toolResult, now)
            }
          }
          return Effect.suspend(() => {
            if (cancellationRequested()) {
              return Effect.succeed(failedCompletion("aborted", "cancelled"))
            }
            activeRun.toolCall = activeToolCall
            activeRun.phase = "tool"
            return withBobSpan(
              {
                name: "bob.tool.invoke",
                correlationId: request.correlationId,
                runId: request.runId,
                feature: featureForToolName(options.catalogue, call.name),
                toolName: call.name,
                toolCallIndex: toolCalls
              },
              Effect.gen(function* () {
                const completedExecution = executionEffect.pipe(
                  Effect.catchCause((cause) =>
                    Cause.hasInterrupts(cause)
                      ? Effect.interrupt
                      : Effect.gen(function* () {
                          yield* recordDecision({
                            name: "bob.decision.policy",
                            code: "provider_failure",
                            outcome: "denied"
                          })
                          return yield* Effect.fail(
                            new ToolInvocationFailure({ result: safeToolFailure() })
                          )
                        })
                  ),
                  Effect.map((toolResult) => ({ type: "result" as const, result: toolResult }))
                )
                const execution = yield* readOnly
                  ? Effect.raceFirst(
                      Effect.raceFirst(completedExecution, timeoutEffect),
                      externalCancellationEffect
                    )
                  : Effect.uninterruptible(completedExecution)
                if (execution.type === "timeout" || execution.type === "failed") {
                  if (execution.type === "failed") return execution
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
              ),
              Effect.ensuring(
                Effect.sync(() => {
                  if (activeRun.toolCall === activeToolCall) {
                    delete activeRun.toolCall
                    activeRun.phase = "checkpoint"
                  }
                })
              )
            )
          })
        }

        let replayState: ReplayState = { type: "initial" }

        for (const operation of storedOperations) {
          if (replayState.type === "final") {
            throw new AgentCheckpointError({ message: "Stored final operation is not terminal" })
          }
          if (operation.kind === "model") {
            if (replayState.type === "awaiting_tools") {
              throw new AgentCheckpointError({
                message: "Stored model operation precedes its pending Tool results"
              })
            }
            const stored = Schema.decodeUnknownSync(ModelOperationPayload)(operation.payload)
            const priorContinuation =
              replayState.type === "awaiting_model" ? replayState.continuation : undefined
            if (priorContinuation === undefined) {
              if (stored.turnIndex !== 1 || stored.turnPhase !== "primary") {
                throw new AgentCheckpointError({
                  message: "Stored first model operation has an invalid turn"
                })
              }
            } else {
              const priorCalls = toolCallsFromAssistant(priorContinuation.assistant)
              const afterCompletedTools =
                priorCalls.length > 0 && priorContinuation.completed.size === priorCalls.length
              const startsRepair =
                priorCalls.length === 0 && priorContinuation.turnPhase === "primary"
              const expectedPhase = startsRepair ? "repair" : "primary"
              if (
                (!afterCompletedTools && !startsRepair) ||
                stored.turnIndex !== priorContinuation.turnIndex + 1 ||
                stored.turnPhase !== expectedPhase
              ) {
                throw new AgentCheckpointError({
                  message: "Stored model operation does not match the next Agent turn"
                })
              }
            }
            const storedMessage = mutableAssistantMessage(stored.message)
            const calls = toolCallsFromAssistant(storedMessage)
            if (stored.turnPhase === "repair" && calls.length > 0) {
              throw new AgentCheckpointError({
                message: "Stored repair model operation contains Tool calls"
              })
            }
            if (new Set(calls.map((call) => call.id)).size !== calls.length) {
              throw new AgentCheckpointError({
                message: "Stored model operation contains duplicate Tool call IDs"
              })
            }
            turns = stored.turnIndex
            inputTokens += storedMessage.usage.input
            outputTokens += storedMessage.usage.output
            context.messages.push(storedMessage)
            const continuation: ReplayContinuation = {
              assistant: storedMessage,
              turnIndex: stored.turnIndex,
              turnPhase: stored.turnPhase,
              completed: new Map()
            }
            replayState =
              calls.length === 0
                ? { type: "awaiting_model", continuation }
                : { type: "awaiting_tools", continuation, calls, nextToolIndex: 0 }
            continue
          }
          if (operation.kind === "tool") {
            if (replayState.type !== "awaiting_tools") {
              throw new AgentCheckpointError({
                message: "Stored Tool operation has no pending Tool call"
              })
            }
            const stored = Schema.decodeUnknownSync(ToolOperationPayload)(operation.payload)
            const continuation: ReplayContinuation = replayState.continuation
            const calls: readonly ToolCall[] = replayState.calls
            const nextToolIndex: number = replayState.nextToolIndex
            if (continuation.turnIndex !== stored.turnIndex) {
              throw new AgentCheckpointError({
                message: "Stored Tool operation does not match its model turn"
              })
            }
            const call = calls[nextToolIndex]
            if (call === undefined || call.id !== stored.toolCallId) {
              throw new AgentCheckpointError({
                message: "Stored Tool operation is not the next pending Tool call"
              })
            }
            toolCalls += 1
            if (stored.toolCallIndex !== toolCalls) {
              throw new AgentCheckpointError({
                message: "Stored Tool operation index is not contiguous"
              })
            }
            executedToolNames.add(call.name)
            recordCompletedToolResult(call.name, stored.result)
            const completed = new Map(continuation.completed)
            completed.set(call.id, stored.result)
            const updatedContinuation: ReplayContinuation = { ...continuation, completed }
            context.messages.push(toolResultMessage(call, stored.result, () => stored.timestamp))
            if (!stored.result.ok && toolResultNeedsReflection(stored.result)) context.tools = []
            replayState =
              nextToolIndex + 1 === calls.length
                ? { type: "awaiting_model", continuation: updatedContinuation }
                : {
                    type: "awaiting_tools",
                    continuation: updatedContinuation,
                    calls,
                    nextToolIndex: nextToolIndex + 1
                  }
            continue
          }
          if (replayState.type === "awaiting_tools") {
            throw new AgentCheckpointError({
              message: "Stored final operation precedes its pending Tool results"
            })
          }
          if (
            replayState.type === "awaiting_model" &&
            toolCallsFromAssistant(replayState.continuation.assistant).length > 0
          ) {
            throw new AgentCheckpointError({
              message: "Stored final operation has no final model response"
            })
          }
          const restoredFinal = Schema.decodeUnknownSync(AgentRunResultSchema)(operation.payload)
          if (
            restoredFinal.runId !== request.runId ||
            restoredFinal.correlationId !== request.correlationId
          ) {
            throw new AgentCheckpointError({
              message: "Stored final operation identity does not match the Agent run"
            })
          }
          replayState = { type: "final", result: restoredFinal }
        }
        let restoredContinuation =
          replayState.type === "awaiting_tools" || replayState.type === "awaiting_model"
            ? replayState.continuation
            : undefined
        const restoredFinal = replayState.type === "final" ? replayState.result : undefined

        const continueAssistant = (
          assistant: AssistantMessage,
          turnIndex: number,
          completed: ReadonlyMap<string, ToolResult>
        ): Effect.Effect<LoopIteration> =>
          Effect.gen(function* () {
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

              let toolResult = completed.get(call.id)
              if (toolResult === undefined) {
                if (toolCalls >= request.limits.maxToolCalls) {
                  yield* recordDecision({
                    name: "bob.decision.tool_gate",
                    code: "limit",
                    outcome: "denied"
                  })
                  toolResults.push(safeToolFailure())
                  return { type: "failed" as const, errorMessage: "Tool-call limit reached." }
                }

                yield* recordDecision({
                  name: "bob.decision.tool_gate",
                  code: "allowed",
                  outcome: "allowed"
                })
                if (cancellationRequested()) return failedCompletion("aborted", "cancelled")
                const command = yield* Effect.promise(() =>
                  toolCommandForCall(options.catalogue, request, tool.label, call.id, parameters)
                )
                if (cancellationRequested()) return failedCompletion("aborted", "cancelled")
                const execution = yield* executeCall(tool, call, command)
                if (execution.type !== "completed") return execution
                toolResult = execution.result
                const toolCheckpointed = yield* appendOperation(
                  "tool",
                  Schema.decodeUnknownSync(Schema.Json)({
                    turnIndex,
                    toolCallIndex: toolCalls,
                    toolCallId: call.id,
                    result: execution.result,
                    timestamp: execution.message.timestamp
                  })
                )
                if (!toolCheckpointed) {
                  return failedCompletion("Agent run checkpoint failed.", "provider")
                }
                context.messages.push(execution.message)
              }

              if (externalSignal?.aborted === true || activeRun.steerRequested) {
                return failedCompletion("aborted", "cancelled")
              }
              if (!toolResult.ok) {
                if (toolResultNeedsReflection(toolResult)) {
                  yield* recordDecision({
                    name: "bob.decision.policy",
                    code:
                      toolResult.code === "external_outcome_unknown"
                        ? "external_unknown"
                        : "confirmation_required",
                    outcome: "applied",
                    toolName: call.name
                  })
                  context.tools = []
                  return { type: "continue" as const }
                }
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

        const runPrimaryTurn = (): Effect.Effect<LoopIteration> => {
          if (cancellationRequested()) {
            return Effect.succeed(failedCompletion("aborted", "cancelled"))
          }
          const resumed = restoredContinuation
          if (resumed !== undefined) restoredContinuation = undefined
          if (resumed === undefined && turns >= turnsLimit) {
            return Effect.gen(function* () {
              yield* recordDecision({
                name: "bob.decision.loop",
                code: "turn_limit",
                outcome: "denied"
              })
              return failedCompletion("Turn limit reached.")
            })
          }
          const turnIndex = resumed?.turnIndex ?? turns + 1
          if (resumed === undefined) turns = turnIndex
          const turnPhase = resumed?.turnPhase ?? "primary"
          return withBobSpan(
            {
              name: "bob.agent.turn",
              correlationId: request.correlationId,
              runId: request.runId,
              feature,
              turnIndex,
              turnPhase
            },
            resumed === undefined
              ? Effect.gen(function* () {
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
                  const modelCheckpointed = yield* appendOperation(
                    "model",
                    Schema.decodeUnknownSync(Schema.Json)({
                      turnIndex,
                      turnPhase: "primary",
                      message: checkpointAssistantMessage(assistant)
                    })
                  )
                  if (!modelCheckpointed) {
                    return failedCompletion("Agent run checkpoint failed.", "provider")
                  }
                  context.messages.push(assistant)
                  return yield* continueAssistant(assistant, turnIndex, new Map())
                })
              : continueAssistant(resumed.assistant, resumed.turnIndex, resumed.completed)
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
          registeredToolNames: new Set(options.catalogue.names),
          executedToolNames,
          confirmedActionToolNames,
          proposedActionToolNames,
          unknownActionToolNames
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
              const decision: BobDecision = {
                name: "bob.decision.output",
                code: validation.ok ? "valid_output" : "repair_required",
                outcome: validation.ok ? "allowed" : "selected"
              }
              if (!validation.ok) Object.assign(decision, { validationCode: validation.code })
              yield* recordDecision(decision)
              return validation
            })
          )

        const completeResult = (
          value: Extract<
            ReturnType<typeof validateAssistantResponse>,
            { readonly ok: true }
          >["value"]
        ): AgentRunResult => {
          const output: AgentRunResult = {
            ...result("completed", value.responseText, undefined),
            sourceIds: value.sourceIds,
            conflict: value.conflict
          }
          if (trustedToolSources.size > 0)
            Object.assign(output, {
              trustedToolSources: [...trustedToolSources.values()].slice(0, 24)
            })
          if (value.artifact !== undefined && value.artifact !== null)
            Object.assign(output, { artifact: value.artifact })
          return output
        }

        const validateAndRepair = (message: AssistantMessage): Effect.Effect<AgentRunResult> =>
          Effect.gen(function* () {
            const initial = yield* validateOutput(structuredOutputText(message))
            if (initial.ok) return completeResult(initial.value)
            const evidenceFallback = deterministicToolResultFallback(
              toolResults,
              request.limits.maxResponseCharacters
            )
            const latestEvidence = toolResults.at(-1)?.evidence
            if (evidenceFallback !== undefined && latestEvidence?.responseText !== undefined) {
              const sources = latestEvidence.sources ?? []
              const output: AgentRunResult = {
                ...result("completed", evidenceFallback, undefined),
                sourceIds: sources.map((source) => source.sourceId),
                conflict: "none"
              }
              if (sources.length > 0) Object.assign(output, { trustedToolSources: sources })
              return output
            }
            if (
              turns >= turnsLimit ||
              externalSignal?.aborted === true ||
              timedOut ||
              activeRun.steerRequested
            ) {
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
                const repairCheckpointed = yield* appendOperation(
                  "model",
                  Schema.decodeUnknownSync(Schema.Json)({
                    turnIndex: repairTurn,
                    turnPhase: "repair",
                    message: checkpointAssistantMessage(completion.message)
                  })
                )
                if (!repairCheckpointed) {
                  return result("failed", undefined, "provider")
                }
                context.messages.push(completion.message)
                const repaired = yield* validateOutput(structuredOutputText(completion.message))
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
          if (activeRun.steerRequested) {
            return result(
              "cancelled",
              deterministicToolResultFallback(toolResults, request.limits.maxResponseCharacters),
              "cancelled"
            )
          }
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
          if (
            toolResults.some(
              (toolResult) => !toolResult.ok && !toolResultNeedsReflection(toolResult)
            )
          ) {
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

        const durableLoopProgram =
          restoredFinal === undefined
            ? loopProgram.pipe(
                Effect.flatMap((output) => {
                  if (output.status !== "completed") return Effect.succeed(output)
                  return appendOperation(
                    "final",
                    Schema.decodeUnknownSync(Schema.Json)(output)
                  ).pipe(
                    Effect.map((checkpointed) =>
                      checkpointed ? output : result("failed", undefined, "provider")
                    )
                  )
                })
              )
            : Effect.succeed(restoredFinal)

        const agentProgram = withBobSpan(
          {
            name: "bob.agent.loop",
            correlationId: request.correlationId,
            runId: request.runId,
            feature
          },
          durableLoopProgram
        )

        return Effect.gen(function* () {
          if (!(yield* prepareContext)) return result("failed", undefined, "provider")
          const timeout = yield* Deferred.make<{ readonly type: "timeout" }>()
          timeoutEffect = Deferred.await(timeout)
          const timeoutFiber = yield* Effect.forkChild(
            Effect.sleep(Math.max(1, request.limits.maxDurationMs)).pipe(
              Effect.tap(() =>
                Effect.sync(() => {
                  timedOut = true
                })
              ),
              Effect.flatMap(() => Deferred.succeed(timeout, { type: "timeout" as const }))
            )
          )
          return yield* agentProgram.pipe(Effect.ensuring(Fiber.interrupt(timeoutFiber)))
        }).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              externalSignal?.removeEventListener("abort", abortFromCaller)
              if (activeRuns.get(request.runId) === activeRun) activeRuns.delete(request.runId)
            })
          )
        )
      },
      catch: (cause) =>
        cause instanceof AgentCheckpointError
          ? cause
          : new AgentCheckpointError({
              message: "Stored Agent run state is invalid",
              cause
            })
    }).pipe(Effect.flatten)

  return {
    runTurnEffect,
    requestSteer: (runId) => {
      const active = activeRuns.get(runId)
      if (active === undefined) {
        pendingSteers.set(runId, now() + pendingSteerRetentionMs)
        return { status: "missing" }
      }
      active.steerRequested = true
      if (active.phase === "model" && active.modelCall !== undefined) {
        active.modelCall.cancel()
        return { status: "aborted_model" }
      }
      if (active.phase === "tool" && active.toolCall?.readOnly === true) {
        active.toolCall.cancel()
      }
      return { status: "queued" }
    },

    getAuthStatus() {
      if (options.provider === "litellm")
        return Effect.succeed({ configured: true, provider: options.provider } as const)
      return Effect.tryPromise({
        try: (signal) => options.credentials.read(options.provider, { signal }),
        catch: (cause) =>
          new AgentProviderError({
            code: "authentication",
            message: "Agent credential status is unavailable",
            cause
          })
      }).pipe(
        Effect.map((credential) => {
          if (credential === undefined)
            return { configured: false, provider: options.provider } as const
          if (credential.type !== "oauth") return { configured: true, provider: options.provider }
          const accountId = Schema.is(Schema.String)(credential.accountId)
            ? credential.accountId
            : undefined
          const status: AuthStatus = {
            configured: true,
            provider: options.provider,
            expiresAt: new Date(credential.expires).toISOString()
          }
          if (accountId !== undefined)
            Object.assign(status, {
              accountIdRedacted: `…${accountId.slice(Math.max(0, accountId.length - 4))}`
            })
          return status
        })
      )
    },

    runSmoke() {
      return Effect.suspend(() => {
        const startedAt = now()
        const result = (
          status: AgentSmokeResult["status"],
          errorCode?: AgentSmokeResult["errorCode"]
        ): AgentSmokeResult => {
          const output: AgentSmokeResult = {
            protocolVersion: 1,
            status,
            model: options.model,
            durationMs: Math.max(0, now() - startedAt)
          }
          if (errorCode !== undefined) Object.assign(output, { errorCode })
          return output
        }
        return Effect.tryPromise({
          try: (signal) =>
            models.completeSimple(
              model,
              {
                systemPrompt:
                  "This is an operational availability check. Reply with exactly READY.",
                messages: [{ role: "user", content: "Reply only READY.", timestamp: now() }],
                tools: []
              },
              { maxRetries: 0, reasoning: "medium", signal, timeoutMs: 30_000 }
            ),
          catch: (cause) => {
            const message = cause instanceof Error ? cause.message : "Model smoke failed"
            const classified = classifyProviderError(message)
            return new AgentProviderError({
              code:
                classified === "policy" || classified === "invalid_output"
                  ? "provider"
                  : classified,
              message,
              cause
            })
          }
        }).pipe(
          Effect.map((message) =>
            message.stopReason === "error"
              ? result("failed", "provider")
              : contentText(message.content).trim() === "READY"
                ? result("completed")
                : result("failed", "invalid_output")
          ),
          Effect.catch((error) => Effect.succeed(result("failed", error.code))),
          Effect.timeoutOrElse({
            duration: 30_000,
            orElse: () => Effect.succeed(result("failed", "timeout"))
          })
        )
      })
    },

    startDeviceLogin() {
      return Effect.suspend(() => {
        if (options.provider !== "openai-codex") {
          return Effect.succeed({
            type: "failed" as const,
            code: "device_login_unavailable" as const
          })
        }
        if (activeLogin !== undefined) {
          return Effect.succeed({ type: "failed" as const, code: "login_already_active" as const })
        }
        const firstEvent = Deferred.makeUnsafe<DeviceLoginEvent>()
        let eventSent = false
        const completeEvent = (event: DeviceLoginEvent) => {
          eventSent = Deferred.doneUnsafe(firstEvent, Effect.succeed(event)) || eventSent
        }
        const interaction: AuthInteraction = {
          async prompt(prompt) {
            if (prompt.type === "select") {
              const device = prompt.options.find((option) => option.id === "device_code")
              if (device === undefined)
                throw new AgentProviderError({
                  code: "authentication",
                  message: "Device login is unavailable"
                })
              return device.id
            }
            throw new AgentProviderError({
              code: "authentication",
              message: "Unexpected interactive prompt during device login"
            })
          },
          notify(event: AuthEvent) {
            if (event.type === "device_code" && !eventSent) {
              completeEvent({
                type: "device_code",
                verificationUri: event.verificationUri,
                userCode: event.userCode,
                expiresAt: new Date(now() + (event.expiresInSeconds ?? 900) * 1_000).toISOString()
              })
            }
          }
        }
        activeLogin = models
          .login(options.provider, "oauth", interaction)
          .catch(() => {
            if (!eventSent) completeEvent({ type: "failed", code: "device_login_failed" })
          })
          .finally(() => {
            activeLogin = undefined
          })
        return waitForDeviceLoginStart(
          Deferred.await(firstEvent),
          options.deviceLoginStartTimeoutMs ?? 15_000
        )
      })
    },

    dispose() {
      for (const active of activeRuns.values()) {
        active.modelCall?.cancel()
        active.toolCall?.cancel()
      }
      activeRuns.clear()
      pendingSteers.clear()
    }
  }
}

export function piAgentLayerWithDependencies(
  options: PiAgentOptions
): Layer.Layer<BobAgent, AgentConfigurationError> {
  return Layer.effect(
    BobAgent,
    Effect.acquireRelease(
      Effect.try({
        try: () => createPiAgent(options),
        catch: (cause) =>
          new AgentConfigurationError({
            message: cause instanceof Error ? cause.message : "Agent configuration is invalid"
          })
      }),
      (agent) => Effect.sync(() => agent.dispose())
    ).pipe(
      Effect.map((agent): BobAgentService => ({
        runTurn: (request, durability) =>
          Effect.suspend(() => {
            const startedAt = Date.now()
            return agent.runTurnEffect(request, undefined, durability).pipe(
              Effect.catchCause((cause) =>
                Cause.hasInterrupts(cause)
                  ? Effect.succeed({
                      protocolVersion: 1 as const,
                      runId: request.runId,
                      correlationId: request.correlationId,
                      status: "cancelled" as const,
                      model: options.model,
                      durationMs: Math.max(0, Date.now() - startedAt),
                      inputTokens: 0,
                      outputTokens: 0,
                      toolCalls: 0,
                      errorCode: "cancelled" as const
                    })
                  : Effect.failCause(cause)
              )
            )
          }),
        runSmoke: () => agent.runSmoke(),
        requestSteer: (runId) => Effect.sync(() => agent.requestSteer(runId)),
        getAuthStatus: () => agent.getAuthStatus(),
        startDeviceLogin: () => agent.startDeviceLogin()
      }))
    )
  )
}
