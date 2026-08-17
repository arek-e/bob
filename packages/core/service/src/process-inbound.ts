import type { AgentArtifact } from "@bob/artifacts-types/artifact"
import type { ConversationTurnSnapshot } from "@bob/conversations-service/turn-store"
import type { CoreBindings } from "@bob/core-types/bindings"
import type { OutboundJob } from "@bob/core-types/jobs"
import type { JobPublisher } from "@bob/job-queue-types"

import { AgentRunResult, type AgentRunRequest } from "@bob/agent-types/run"
import { ArtifactStore } from "@bob/artifacts-types/store"
import { ContextStore } from "@bob/context-types/store"
import { selectAgentResponse } from "@bob/conversations-service/agent-response"
import { conversationTiming } from "@bob/conversations-service/timing"
import { AgentRunStore } from "@bob/conversations-types/run-store"
import { ConversationStore, type ClaimedInbound } from "@bob/conversations-types/store"
import { ToolExecutor } from "@bob/conversations-types/tool-executor"
import { ConversationTurnStore } from "@bob/conversations-types/turn-store"
import { DeliveryStore } from "@bob/delivery-types/store"
import { makeQueueBindingJobPublisher } from "@bob/job-queue-runtime/queue-binding"
import {
  featureForTools,
  recordDecision,
  withBobSpan,
  type BobDecisionCode,
  type BobSpan,
  emitHealth,
  noopTelemetryLayer,
  type TelemetryFeature,
  formatTraceparent,
  injectCurrentTraceparent,
  withTraceparent
} from "@bob/observability"
import { reportAgentFailure, reportAgentUsage } from "@bob/operations-service/usage/reporting"
import { AlertStore } from "@bob/operations-types/alerts"
import {
  classifyDeterministicCommand,
  deterministicCommandLanguage,
  fixedHelpText,
  isArtifactResendRequest,
  urgentSafetyResponse
} from "@bob/policy-service/rules"
import { requiresPersonalGrounding } from "@bob/policy-types/output-safety"
import { OwnerSettingsStore } from "@bob/settings-types/store"
import { Effect, Schema } from "effect"

import type { CoreComposition } from "./composition.ts"

type CoreServiceSet = {
  readonly alerts: (typeof AlertStore)["Service"]
  readonly artifacts: (typeof ArtifactStore)["Service"]
  readonly context: (typeof ContextStore)["Service"]
  readonly conversations: (typeof ConversationStore)["Service"]
  readonly delivery: (typeof DeliveryStore)["Service"]
  readonly runs: (typeof AgentRunStore)["Service"]
  readonly settings: (typeof OwnerSettingsStore)["Service"]
  readonly tools: (typeof ToolExecutor)["Service"]
  readonly turns: (typeof ConversationTurnStore)["Service"]
}

type CoreWorkflowComposition = CoreComposition & { readonly interfaces: CoreServiceSet }
class AgentCallError extends Error {
  readonly _tag = "AgentCallError"

  constructor(readonly code: NonNullable<AgentRunResult["errorCode"]>) {
    super(`Agent host request failed: ${code}`)
  }
}

export function assertAgentResultIdentity(
  request: AgentRunRequest,
  result: AgentRunResult
): AgentRunResult {
  if (result.runId !== request.runId || result.correlationId !== request.correlationId) {
    throw new AgentCallError("policy")
  }
  return result
}

function promiseEffect<A, E>(
  operation: (signal: AbortSignal) => Effect.Effect<A, E>
): Effect.Effect<A, E>
function promiseEffect<A>(
  operation: (signal: AbortSignal) => PromiseLike<A> | A
): Effect.Effect<A, unknown>
function promiseEffect<A, E>(
  operation: (signal: AbortSignal) => PromiseLike<A> | A | Effect.Effect<A, E>
): Effect.Effect<A, E | unknown> {
  return Effect.suspend(() => {
    const controller = new AbortController()
    let result: PromiseLike<A> | A | Effect.Effect<A, E>
    try {
      result = operation(controller.signal)
    } catch (cause) {
      return Effect.fail(cause)
    }
    if (Effect.isEffect(result)) return result
    return Effect.tryPromise({
      try: (signal) => {
        signal.addEventListener("abort", () => controller.abort(signal.reason), { once: true })
        return Promise.resolve(result)
      },
      catch: (cause) => cause
    })
  })
}

function featureForReason(reasonCode: string): TelemetryFeature {
  if (reasonCode.includes("safety")) return "safety"
  return "assistant"
}

function boundedTurnMessages(
  messages: ConversationTurnSnapshot["messages"],
  maximumMessages = 12,
  maximumCharacters = 8_000
): ConversationTurnSnapshot["messages"] {
  const selected: ConversationTurnSnapshot["messages"][number][] = []
  let usedCharacters = 0
  for (const message of messages.toReversed()) {
    if (selected.length >= maximumMessages) break
    if (selected.length > 0 && usedCharacters + message.text.length > maximumCharacters) break
    selected.push(message)
    usedCharacters += message.text.length
  }
  return selected.toReversed()
}

function wakeConversationTurn(
  composition: CoreWorkflowComposition,
  input: { readonly ownerId: string; readonly wakeAt?: string }
) {
  return promiseEffect(async () => {
    try {
      await composition.runCoordinator.wake(input)
    } catch {
      // The durable turn state remains recoverable after a lost live wake-up.
    }
  })
}

function releaseSettlingTurn(
  composition: CoreWorkflowComposition,
  input: { readonly turnId: string; readonly activeRunId: string; readonly ownerId: string }
) {
  return Effect.gen(function* () {
    const released = yield* promiseEffect(() =>
      composition.interfaces.turns.releaseSettling(input.turnId, input.activeRunId)
    )
    if (!released.ready) return released
    yield* wakeConversationTurn(composition, { ownerId: input.ownerId })
    return released
  })
}

interface OutboxTelemetry {
  readonly correlationId: string
  readonly feature: TelemetryFeature
  readonly runId?: string
}

function outboxSpan(
  name: "bob.outbox.create" | "bob.outbox.publish",
  telemetry: OutboxTelemetry,
  outboxId?: string
): BobSpan {
  const common = {
    name,
    correlationId: telemetry.correlationId,
    feature: telemetry.feature
  }
  if (telemetry.runId === undefined && outboxId === undefined) return common
  if (telemetry.runId === undefined && outboxId !== undefined) return { ...common, outboxId }
  if (telemetry.runId !== undefined && outboxId === undefined) {
    return { ...common, runId: telemetry.runId }
  }
  if (telemetry.runId === undefined || outboxId === undefined) return common
  return { ...common, runId: telemetry.runId, outboxId }
}

function withReplyTarget<Input extends object>(
  input: Input,
  replyToMessageHandle: string | undefined
): Input | (Input & { replyToMessageHandle: string }) {
  return replyToMessageHandle === undefined ? input : { ...input, replyToMessageHandle }
}

interface AgentResponseInput {
  channelId: string
  text: string
  reasonCode: string
  artifact?: AgentArtifact
  replyToMessageHandle?: string
}

function agentResponseInput(
  channelId: string,
  text: string,
  reasonCode: string,
  artifact: AgentArtifact | undefined,
  replyToMessageHandle: string | undefined
): AgentResponseInput {
  const common = { channelId, text, reasonCode }
  if (artifact === undefined && replyToMessageHandle === undefined) return common
  if (artifact === undefined && replyToMessageHandle !== undefined) {
    return { ...common, replyToMessageHandle }
  }
  if (artifact !== undefined && replyToMessageHandle === undefined) return { ...common, artifact }
  if (artifact === undefined || replyToMessageHandle === undefined) return common
  return { ...common, artifact, replyToMessageHandle }
}

function publishOutbox(
  publisher: JobPublisher<OutboundJob>,
  composition: CoreWorkflowComposition,
  outboxId: string,
  telemetry: OutboxTelemetry
) {
  return withBobSpan(
    outboxSpan("bob.outbox.publish", telemetry, outboxId),
    Effect.gen(function* () {
      const span = yield* Effect.currentSpan
      yield* promiseEffect(() =>
        publisher.publish({
          outboxId,
          dispatchGeneration: 0,
          correlationId: telemetry.correlationId,
          traceparent: formatTraceparent(span)
        } satisfies OutboundJob)
      )
      yield* promiseEffect(() =>
        composition.interfaces.delivery.markEnqueued(outboxId, new Date().toISOString(), 0)
      )
    })
  )
}

function nativeReplyTarget(claimed: ClaimedInbound): string | undefined {
  return claimed.service === "imessage" && !claimed.isGroup
    ? claimed.providerMessageHandle
    : undefined
}

function messageInteractionLifecycle(
  composition: CoreWorkflowComposition,
  claimed: ClaimedInbound
) {
  const eligible = nativeReplyTarget(claimed) !== undefined
  const egressUrl = composition.config.CHANNEL_EGRESS_URL
  if (!eligible || egressUrl.length === 0) {
    return { start: Effect.void, stop: Effect.void }
  }

  const post = <Input>(body: Input) =>
    Effect.promise(async () => {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort("message_interaction_timeout"), 3_000)
      try {
        await fetch(`${egressUrl}/internal/message-interaction`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-bob-caller-token": composition.config.EGRESS_CALLER_SECRET,
            "x-bob-correlation-id": claimed.correlationId
          },
          body: JSON.stringify(body),
          signal: controller.signal
        })
      } catch {
        // Native message cues are best effort. They never block the durable action.
      } finally {
        clearTimeout(timeout)
      }
    })

  return {
    start: Effect.gen(function* () {
      const react = yield* promiseEffect(() =>
        composition.interfaces.conversations.claimReaction(
          claimed.eventId,
          new Date().toISOString()
        )
      ).pipe(Effect.catch(() => Effect.succeed(false)))
      yield* post({
        action: "start",
        number: claimed.number,
        fromNumber: claimed.fromNumber,
        messageHandle: claimed.providerMessageHandle,
        react,
        maxDurationMs: 90_000
      })
    }),
    stop: post({
      action: "stop",
      number: claimed.number,
      fromNumber: claimed.fromNumber
    })
  }
}

function deterministicReply(
  composition: CoreWorkflowComposition,
  claimed: ClaimedInbound,
  safetyText: string,
  actionIdempotencyScope: string,
  replyIdempotencyScope: string,
  begin: () => Effect.Effect<boolean, unknown>,
  enqueue: (input: {
    readonly ownerId: string
    readonly channelId: string
    readonly text: string
    readonly reasonCode: string
    readonly correlationId: string
    readonly idempotencyKey: string
    readonly replyToMessageHandle?: string
    readonly feature?: TelemetryFeature
  }) => Effect.Effect<void, unknown>
) {
  const replyToMessageHandle = nativeReplyTarget(claimed)
  return Effect.gen(function* () {
    const urgent = urgentSafetyResponse(safetyText)
    if (urgent !== undefined) {
      yield* recordDecision({
        name: "bob.decision.route",
        code: "urgent_safety",
        outcome: "selected"
      })
      if (!(yield* begin())) return true
      yield* enqueue(
        withReplyTarget(
          {
            ownerId: claimed.ownerId,
            channelId: claimed.channelId,
            text: urgent,
            reasonCode: "urgent_safety",
            correlationId: claimed.correlationId,
            idempotencyKey: `${replyIdempotencyScope}:urgent`
          },
          replyToMessageHandle
        )
      )
      return true
    }

    for (const workflow of composition.modules.conversations) {
      const prepared = yield* promiseEffect(() =>
        workflow.prepare({
          ownerId: claimed.ownerId,
          channelId: claimed.channelId,
          messageId: claimed.messageId,
          text: claimed.text,
          policyText: safetyText,
          actionIdempotencyScope,
          now: new Date()
        })
      )
      if (prepared === undefined) continue
      yield* recordDecision({
        name: "bob.decision.route",
        code: "deterministic_command",
        outcome: "selected"
      })
      if (!(yield* begin())) return true
      const result = yield* promiseEffect(() => prepared.execute())
      if (result.text !== undefined) {
        yield* enqueue(
          withReplyTarget(
            {
              ownerId: claimed.ownerId,
              channelId: claimed.channelId,
              text: result.text,
              reasonCode: result.reasonCode,
              correlationId: claimed.correlationId,
              idempotencyKey: `${replyIdempotencyScope}:${workflow.id}`,
              feature: result.feature
            },
            replyToMessageHandle
          )
        )
      }
      return true
    }

    const explicitCommand = classifyDeterministicCommand(claimed.text)
    const artifactResendRequested =
      explicitCommand === "repeat" || isArtifactResendRequest(claimed.text)
    const latestArtifact = artifactResendRequested
      ? yield* promiseEffect(() =>
          composition.interfaces.artifacts.latest(claimed.ownerId, claimed.channelId)
        )
      : undefined
    const command = latestArtifact === undefined ? explicitCommand : "repeat"
    if (command === undefined) {
      yield* recordDecision({
        name: "bob.decision.route",
        code: "agent_turn",
        outcome: "selected"
      })
      return false
    }

    yield* recordDecision({
      name: "bob.decision.route",
      code: "deterministic_command",
      outcome: "selected"
    })
    if (!(yield* begin())) return true
    const language = deterministicCommandLanguage(claimed.text)
    const swedish = language === "sv"
    let response: string
    switch (command) {
      case "help":
        response = fixedHelpText(language)
        break
      case "stop":
      case "cancel":
        response =
          "The Channel Adapter manages opt-out words. Bob will stop messages after it confirms opt-out."
        break
      case "start":
        response =
          "The Channel Adapter manages START. Bob resumes only after it confirms the change."
        break
      case "repeat":
        response =
          latestArtifact?.renderedText ??
          (swedish
            ? "Öppna Bob för att se det senaste meddelandet."
            : "Open Bob to view the last message.")
        break
      case "why":
        response = swedish
          ? "Öppna Bob för att se den sparade orsaken och källan för den senaste åtgärden."
          : "Open Bob to view the stored reason and source for the last action."
        break
      case "pause":
        response = swedish
          ? "Den här interaktionen är pausad. Inga sparade åtgärder ändras."
          : "This interaction is paused. No saved actions changed."
        break
      case "undo":
        response = swedish
          ? "Jag kan inte koppla ÅNGRA till en säker omvänd åtgärd. Öppna Bob och välj en post."
          : "I cannot match UNDO to one safe inverse action. Open Bob to choose an item."
        break
    }
    yield* enqueue(
      withReplyTarget(
        {
          ownerId: claimed.ownerId,
          channelId: claimed.channelId,
          text: response,
          reasonCode: `command_${command}`,
          correlationId: claimed.correlationId,
          idempotencyKey: `${replyIdempotencyScope}:command`
        },
        replyToMessageHandle
      )
    )
    return true
  })
}

function agentDecisionCode(
  status: AgentRunResult["status"],
  errorCode?: AgentRunResult["errorCode"]
): BobDecisionCode {
  if (status === "completed") return "allowed"
  if (errorCode === "timeout" || errorCode === "cancelled") return "timeout"
  if (errorCode === "invalid_output" || errorCode === "policy") return "invalid_output"
  return "provider_failure"
}

function agentCallErrorCode(cause: unknown): NonNullable<AgentRunResult["errorCode"]> {
  if (cause instanceof AgentCallError) return cause.code
  if (Schema.is(Schema.Struct({ _tag: Schema.Literal("TimeoutException") }))(cause)) {
    return "timeout"
  }
  return "provider"
}

function failedAgentResult(
  request: AgentRunRequest,
  model: string,
  cause: unknown
): AgentRunResult {
  return {
    protocolVersion: 1,
    runId: request.runId,
    correlationId: request.correlationId,
    status: "failed",
    errorCode: agentCallErrorCode(cause),
    model,
    durationMs: request.limits.maxDurationMs,
    inputTokens: 0,
    outputTokens: 0,
    toolCalls: 0
  }
}

function isRetryableAgentResult(result: AgentRunResult): boolean {
  return (
    result.status !== "completed" &&
    (result.errorCode === "provider" || result.errorCode === "timeout")
  )
}

function cancelledAgentResult(request: AgentRunRequest, model: string): AgentRunResult {
  return {
    protocolVersion: 1,
    runId: request.runId,
    correlationId: request.correlationId,
    status: "cancelled",
    errorCode: "cancelled",
    model,
    durationMs: 0,
    inputTokens: 0,
    outputTokens: 0,
    toolCalls: 0
  }
}

function unknownMutationAgentResult(request: AgentRunRequest, model: string): AgentRunResult {
  return {
    protocolVersion: 1,
    runId: request.runId,
    correlationId: request.correlationId,
    status: "failed",
    errorCode: "provider",
    responseText:
      "I could not confirm whether that action finished. Review the current state before you try it again.",
    model,
    durationMs: 0,
    inputTokens: 0,
    outputTokens: 0,
    toolCalls: 1
  }
}

function suppressStaleAgentAttempt(
  composition: CoreWorkflowComposition,
  input: {
    readonly result: AgentRunResult
    readonly attemptId: string
    readonly turn: ConversationTurnSnapshot
    readonly feature: TelemetryFeature
  }
) {
  return withBobSpan(
    {
      name: "bob.reply.suppress",
      correlationId: input.turn.latest.correlationId,
      runId: input.result.runId,
      conversationTurnId: input.turn.turnId,
      conversationRevision: input.turn.revision,
      feature: input.feature
    },
    Effect.gen(function* () {
      yield* recordDecision({
        name: "bob.decision.steering",
        code: "stale_reply_suppressed",
        outcome: "applied",
        conversationRevision: input.turn.revision
      })
      const suppressed = yield* promiseEffect(() =>
        composition.interfaces.runs.completeWithoutResponse(input.result, input.attemptId)
      )
      if (!suppressed) return false
      yield* releaseSettlingTurn(composition, {
        turnId: input.turn.turnId,
        activeRunId: input.result.runId,
        ownerId: input.turn.ownerId
      })
      return true
    })
  )
}

function invokeAgent(
  request: AgentRunRequest,
  attemptId: string,
  composition: CoreWorkflowComposition,
  feature: TelemetryFeature
) {
  return withBobSpan(
    {
      name: "bob.agent.invoke",
      correlationId: request.correlationId,
      runId: request.runId,
      feature
    },
    Effect.gen(function* () {
      const headers = yield* injectCurrentTraceparent({
        "content-type": "application/json",
        "x-bob-caller-token": composition.config.AGENT_CALLER_SECRET,
        "x-bob-correlation-id": request.correlationId,
        "x-bob-run-attempt-id": attemptId
      })
      const call = Effect.tryPromise({
        try: async (signal) => {
          const response = await fetch(`${composition.config.AGENT_URL}/v1/run`, {
            method: "POST",
            headers,
            body: JSON.stringify(request),
            signal
          })
          if (!response.ok) {
            const code =
              response.status === 401 || response.status === 403
                ? "authentication"
                : response.status === 429
                  ? "quota"
                  : response.status === 408 || response.status === 504
                    ? "timeout"
                    : response.status >= 400 && response.status < 500
                      ? "policy"
                      : "provider"
            throw new AgentCallError(code)
          }
          return assertAgentResultIdentity(
            request,
            Schema.decodeUnknownSync(AgentRunResult)(await response.json())
          )
        },
        catch: (error) => (error instanceof AgentCallError ? error : new AgentCallError("provider"))
      }).pipe(
        Effect.timeout(conversationTiming.coreAgentTimeoutMs),
        Effect.tap((result) =>
          recordDecision({
            name: "bob.decision.policy",
            code: agentDecisionCode(result.status, result.errorCode),
            outcome: result.status === "completed" ? "allowed" : "denied"
          })
        ),
        Effect.tapError((error) =>
          recordDecision({
            name: "bob.decision.policy",
            code: agentDecisionCode("failed", agentCallErrorCode(error)),
            outcome: "denied"
          })
        )
      )
      return yield* call
    })
  )
}

export function processConversationTurnEffect(
  conversationTurn: ConversationTurnSnapshot,
  bindings: CoreBindings,
  core: CoreComposition
) {
  const correlationId = conversationTurn.latest.correlationId
  const outboundPublisher =
    core.jobQueue?.outbound ??
    (bindings.OUTBOUND_QUEUE === undefined
      ? {
          publish: async () => {
            throw new Error("Outbound Job Queue is required")
          }
        }
      : makeQueueBindingJobPublisher(bindings.OUTBOUND_QUEUE))
  let interactionStop: Effect.Effect<void> = Effect.void
  const process = withBobSpan(
    {
      name: "bob.inbound.process",
      correlationId,
      feature: "assistant"
    },
    Effect.gen(function* () {
      const composition: CoreWorkflowComposition = {
        ...core,
        interfaces: {
          alerts: yield* AlertStore,
          artifacts: yield* ArtifactStore,
          context: yield* ContextStore,
          conversations: yield* ConversationStore,
          delivery: yield* DeliveryStore,
          runs: yield* AgentRunStore,
          settings: yield* OwnerSettingsStore,
          tools: yield* ToolExecutor,
          turns: yield* ConversationTurnStore
        }
      }
      const claimed = {
        ...conversationTurn.latest,
        ownerId: conversationTurn.ownerId,
        channelId: conversationTurn.channelId
      }

      const interaction = messageInteractionLifecycle(composition, claimed)
      const replyToMessageHandle = nativeReplyTarget(claimed)
      interactionStop = interaction.stop
      yield* interaction.start

      const turn = conversationTurn
      const deterministicRunId = turn.latest.eventId
      const releaseDeterministic = () =>
        releaseSettlingTurn(composition, {
          turnId: turn.turnId,
          activeRunId: deterministicRunId,
          ownerId: claimed.ownerId
        }).pipe(Effect.asVoid)
      const beginDeterministic = () =>
        Effect.gen(function* () {
          const started = yield* promiseEffect(() =>
            composition.interfaces.turns.markRunning(turn.turnId, turn.revision, deterministicRunId)
          )
          if (!started) return false
          const currentRevision = yield* promiseEffect(() =>
            composition.interfaces.turns.currentRevision(turn.turnId)
          )
          if (currentRevision === turn.revision) return true
          yield* recordDecision({
            name: "bob.decision.steering",
            code: "stale_reply_suppressed",
            outcome: "applied",
            conversationRevision: turn.revision
          })
          yield* releaseDeterministic()
          return false
        })
      const enqueueDeterministic = (input: {
        readonly ownerId: string
        readonly channelId: string
        readonly text: string
        readonly reasonCode: string
        readonly correlationId: string
        readonly idempotencyKey: string
        readonly replyToMessageHandle?: string
        readonly feature?: TelemetryFeature
      }) => {
        const feature = input.feature ?? featureForReason(input.reasonCode)
        return Effect.gen(function* () {
          if (
            (yield* promiseEffect(() =>
              composition.interfaces.turns.currentRevision(turn.turnId)
            )) !== turn.revision
          ) {
            yield* recordDecision({
              name: "bob.decision.steering",
              code: "stale_reply_suppressed",
              outcome: "applied",
              conversationRevision: turn.revision
            })
            yield* releaseDeterministic()
            return
          }
          const outboxId = yield* withBobSpan(
            {
              name: "bob.outbox.create",
              correlationId: input.correlationId,
              feature
            },
            promiseEffect(() =>
              composition.interfaces.delivery.createOutbox({
                ...input,
                conversationTurnId: turn.turnId,
                conversationTurnRevision: turn.revision
              })
            )
          )
          const committed = yield* withBobSpan(
            {
              name: "bob.reply.commit",
              correlationId: input.correlationId,
              conversationTurnId: turn.turnId,
              conversationRevision: turn.revision,
              feature
            },
            promiseEffect(() =>
              composition.interfaces.turns.commitReply(
                turn.turnId,
                turn.revision,
                deterministicRunId,
                outboxId
              )
            )
          )
          if (committed === "superseded") {
            yield* recordDecision({
              name: "bob.decision.steering",
              code: "stale_reply_suppressed",
              outcome: "applied",
              conversationRevision: turn.revision
            })
            yield* releaseDeterministic()
            return
          }
          yield* promiseEffect(() =>
            composition.interfaces.turns.markEventsProcessed(turn.turnId, turn.revision)
          )
          yield* publishOutbox(outboundPublisher, composition, outboxId, {
            correlationId: input.correlationId,
            feature
          })
        })
      }
      const safetyText = turn.messages.map((message) => message.text).join("\n")
      const deterministicActionScope = `turn:${turn.turnId}`
      const deterministicReplyScope = `turn:${turn.turnId}:revision:${turn.revision}`
      if (
        yield* deterministicReply(
          composition,
          claimed,
          safetyText,
          deterministicActionScope,
          deterministicReplyScope,
          beginDeterministic,
          enqueueDeterministic
        )
      )
        return

      const stored = yield* promiseEffect(() =>
        composition.interfaces.runs.loadForTurn(conversationTurn.turnId, conversationTurn.revision)
      )
      let request: AgentRunRequest | undefined = stored?.request
      if (request === undefined) {
        const ownerSettings = yield* promiseEffect(() =>
          composition.interfaces.settings.get(claimed.ownerId)
        )
        const localTime = new Date().toISOString()
        const runId = crypto.randomUUID()
        const turnMessages = boundedTurnMessages(conversationTurn.messages)
        const currentTurnText = turnMessages.map((message) => message.text).join("\n")
        const contextBuildRequest = {
          ownerId: claimed.ownerId,
          channelId: claimed.channelId,
          currentMessageId: claimed.messageId,
          currentUserText: currentTurnText,
          localTime,
          timeZone: ownerSettings.timeZone,
          currentConversationTurnId: conversationTurn.turnId,
          currentConversationTurnRevision: conversationTurn.revision
        }
        const allowedTools = [...composition.profile.modelToolNames]
        const feature = featureForTools(composition.profile, allowedTools)
        const retrievalStartedAt = Date.now()
        const retrieve = withBobSpan(
          {
            name: "bob.context.build",
            correlationId: claimed.correlationId,
            runId,
            feature
          },
          withBobSpan(
            {
              name: "bob.context.retrieve",
              correlationId: claimed.correlationId,
              runId,
              feature
            },
            promiseEffect(() => composition.interfaces.context.build(contextBuildRequest))
          )
        ).pipe(
          Effect.tap((contextItems) =>
            emitHealth({
              type: "retrieval",
              correlationId: claimed.correlationId,
              runId,
              feature,
              workflow: "agent_turn",
              strategy: "fts",
              status: "completed",
              selectedCount: contextItems.length,
              sourceCount: contextItems.reduce((count, item) => count + item.sources.length, 0),
              conflictCount: contextItems.filter((item) => item.conflict).length,
              durationMs: Math.max(0, Date.now() - retrievalStartedAt)
            })
          ),
          Effect.tapError(() =>
            emitHealth({
              type: "retrieval",
              correlationId: claimed.correlationId,
              runId,
              feature,
              workflow: "agent_turn",
              strategy: "fts",
              status: "failed",
              selectedCount: 0,
              sourceCount: 0,
              conflictCount: 0,
              durationMs: Math.max(0, Date.now() - retrievalStartedAt)
            })
          )
        )
        const contextItems = yield* retrieve
        const priorToolReceipts = yield* promiseEffect(
          () => composition.interfaces.context.priorToolReceipts?.(contextBuildRequest) ?? []
        )
        if (priorToolReceipts.length > 0) {
          const decision = {
            name: "bob.decision.steering",
            code: "restart_with_receipts",
            outcome: "applied",
            selectedCount: priorToolReceipts.length
          } as const
          yield* recordDecision({
            ...decision,
            conversationRevision: conversationTurn.revision
          })
        }
        const requestWithTurn = {
          protocolVersion: 1 as const,
          deploymentProfileId: composition.profile.profileId,
          capabilityCatalogueGeneration: composition.profile.generation,
          runId,
          ownerId: claimed.ownerId,
          correlationId: claimed.correlationId,
          sourceMessageId: claimed.messageId,
          localTime,
          timeZone: ownerSettings.timeZone,
          locale: ownerSettings.locale,
          hourCycle: ownerSettings.hourCycle,
          userText: claimed.text,
          grounding: { requiresSources: requiresPersonalGrounding(currentTurnText) },
          contextItems,
          allowedTools,
          conversationTurnId: conversationTurn.turnId,
          conversationTurnRevision: conversationTurn.revision,
          currentTurnMessages: turnMessages.map((message) => ({
            sourceMessageId: message.messageId,
            text: message.text
          })),
          limits: {
            maxTurns: 4,
            maxToolCalls: 4,
            maxDurationMs: conversationTiming.modelDurationMs,
            maxResponseCharacters: 1_200
          }
        }
        request =
          priorToolReceipts.length === 0
            ? requestWithTurn
            : { ...requestWithTurn, priorToolReceipts }
      }

      const agentRequest =
        stored !== undefined &&
        (request.deploymentProfileId === undefined ||
          request.capabilityCatalogueGeneration === undefined)
          ? { ...request, legacySnapshotReplay: true as const }
          : request
      const feature = featureForTools(composition.profile, agentRequest.allowedTools)
      const created = yield* withBobSpan(
        {
          name: "bob.agent_run.persist",
          correlationId: claimed.correlationId,
          runId: agentRequest.runId,
          feature
        },
        stored === undefined
          ? promiseEffect(() => composition.interfaces.runs.create(agentRequest, claimed.eventId))
          : Effect.succeed({ runId: agentRequest.runId, duplicate: true })
      )

      if (
        !(yield* promiseEffect(() =>
          composition.interfaces.turns.markRunning(
            conversationTurn.turnId,
            conversationTurn.revision,
            agentRequest.runId
          )
        ))
      ) {
        return
      }

      if (
        stored?.status === "completed" ||
        stored?.status === "failed" ||
        stored?.status === "superseded"
      ) {
        const exactTurn =
          stored.request.conversationTurnId === conversationTurn.turnId &&
          stored.request.conversationTurnRevision === conversationTurn.revision &&
          stored.request.sourceMessageId === conversationTurn.latest.messageId
        if (!exactTurn || stored.outboxId === undefined) return
        const storedOutboxId = stored.outboxId
        const committed = yield* promiseEffect(() =>
          composition.interfaces.turns.commitReply(
            conversationTurn.turnId,
            conversationTurn.revision,
            stored.request.runId,
            storedOutboxId
          )
        )
        if (committed === "superseded") {
          yield* releaseSettlingTurn(composition, {
            turnId: conversationTurn.turnId,
            activeRunId: stored.request.runId,
            ownerId: claimed.ownerId
          })
          return
        }
        yield* promiseEffect(() =>
          composition.interfaces.turns.markEventsProcessed(
            conversationTurn.turnId,
            conversationTurn.revision
          )
        )
        yield* publishOutbox(outboundPublisher, composition, storedOutboxId, {
          correlationId: claimed.correlationId,
          feature,
          runId: stored.request.runId
        })
        return
      }

      const runAttemptId = yield* promiseEffect(() =>
        composition.interfaces.runs.claim(created.runId, conversationTiming.activeLeaseMs)
      )
      yield* recordDecision({
        name: "bob.decision.idempotency",
        code: runAttemptId === undefined ? "in_progress" : "allowed",
        outcome: runAttemptId === undefined ? "skipped" : "allowed"
      })
      if (runAttemptId === undefined) return

      if (
        (yield* promiseEffect(() =>
          composition.interfaces.turns.currentRevision(conversationTurn.turnId)
        )) !== conversationTurn.revision
      ) {
        yield* suppressStaleAgentAttempt(composition, {
          result: cancelledAgentResult(agentRequest, composition.config.BOB_MODEL),
          attemptId: runAttemptId,
          turn: conversationTurn,
          feature
        })
        return
      }

      let result = yield* invokeAgent(agentRequest, runAttemptId, composition, feature).pipe(
        Effect.catch((error) =>
          Effect.succeed(failedAgentResult(agentRequest, composition.config.BOB_MODEL, error))
        )
      )
      let mutationActivity = yield* promiseEffect(
        () =>
          composition.interfaces.tools?.mutationActivity?.(agentRequest.runId) ?? { status: "none" }
      )
      let mutationCompletedDuringRecovery = false
      if (
        mutationActivity.status === "active" &&
        mutationActivity.recoveryRequired &&
        agentRequest.conversationTurnRevision !== undefined &&
        (mutationActivity.recoveryExhausted ||
          (mutationActivity.originRevision !== undefined &&
            agentRequest.conversationTurnRevision > mutationActivity.originRevision))
      ) {
        const expired = yield* promiseEffect(() =>
          composition.interfaces.tools.expireMutationRecovery(agentRequest.runId)
        )
        mutationActivity = yield* promiseEffect(() =>
          composition.interfaces.tools.mutationActivity(agentRequest.runId)
        )
        mutationCompletedDuringRecovery = mutationActivity.status === "completed"
        if (expired && mutationActivity.status === "none") {
          result = unknownMutationAgentResult(agentRequest, composition.config.BOB_MODEL)
        }
      }
      if (mutationActivity.status === "unknown") {
        result = unknownMutationAgentResult(agentRequest, composition.config.BOB_MODEL)
      }
      if (mutationActivity.status === "none" && isRetryableAgentResult(result)) {
        if (
          (yield* promiseEffect(() =>
            composition.interfaces.turns.currentRevision(conversationTurn.turnId)
          )) !== conversationTurn.revision
        ) {
          yield* suppressStaleAgentAttempt(composition, {
            result,
            attemptId: runAttemptId,
            turn: conversationTurn,
            feature
          })
          return
        }
        const retry = yield* promiseEffect(() =>
          composition.interfaces.runs.releaseForRetry(
            result,
            runAttemptId,
            conversationTiming.maxAgentRunAttempts,
            conversationTiming.agentRunRetryDelayMs,
            {
              conversationTurnId: conversationTurn.turnId,
              conversationTurnRevision: conversationTurn.revision
            }
          )
        )
        yield* recordDecision({
          name: "bob.decision.idempotency",
          code:
            retry.status === "released"
              ? "allowed"
              : retry.status === "exhausted"
                ? "limit"
                : "in_progress",
          outcome: retry.status === "released" ? "allowed" : "skipped"
        })
        if (retry.status === "lost") return
        if (retry.status === "released") {
          yield* wakeConversationTurn(
            composition,
            retry.wakeAt === undefined
              ? { ownerId: conversationTurn.ownerId }
              : { ownerId: conversationTurn.ownerId, wakeAt: retry.wakeAt }
          )
          return
        }
      }
      yield* promiseEffect(() =>
        reportAgentUsage(
          composition.applicationStorage,
          composition.interfaces.alerts,
          {
            runId: result.runId,
            ownerId: claimed.ownerId,
            correlationId: result.correlationId,
            feature,
            provider: "openai-codex",
            model: result.model,
            status: result.status,
            inputTokens: result.inputTokens,
            outputTokens: result.outputTokens,
            toolCalls: result.toolCalls,
            durationMs: result.durationMs,
            occurredAt: new Date().toISOString()
          },
          {
            runTokens: composition.config.BOB_RUN_TOKEN_BUDGET,
            dailyTokens: composition.config.BOB_DAILY_TOKEN_BUDGET
          }
        )
      )
      yield* promiseEffect(() =>
        reportAgentFailure(composition.interfaces.alerts, claimed.ownerId, result)
      )
      const receiptBackedRun =
        agentRequest.priorToolReceipts?.some((receipt) => receipt.origin === "same_turn") === true
      if (
        mutationActivity.status === "active" ||
        (mutationActivity.status === "completed" &&
          result.status !== "completed" &&
          (mutationActivity.completedInRun || mutationCompletedDuringRecovery) &&
          !receiptBackedRun)
      ) {
        const decision = {
          name: "bob.decision.steering",
          code: mutationActivity.status === "active" ? "wait_effect" : "restart_with_receipts",
          outcome: "applied",
          selectedCount: 1
        } as const
        yield* recordDecision({
          ...decision,
          conversationRevision: conversationTurn.revision
        })
        const transition = yield* promiseEffect(() =>
          composition.interfaces.runs.completeForReflection(
            result,
            runAttemptId,
            mutationActivity.status === "active"
              ? {
                  conversationTurnId: conversationTurn.turnId,
                  conversationTurnRevision: conversationTurn.revision,
                  settleUntil: mutationActivity.retryAt
                }
              : {
                  conversationTurnId: conversationTurn.turnId,
                  conversationTurnRevision: conversationTurn.revision
                }
          )
        )
        if (transition.status === "lost") return
        if (transition.status === "settling") {
          const settledActivity = yield* promiseEffect(() =>
            composition.interfaces.tools.mutationActivity(agentRequest.runId)
          )
          if (settledActivity.status !== "active") {
            yield* releaseSettlingTurn(composition, {
              turnId: conversationTurn.turnId,
              activeRunId: agentRequest.runId,
              ownerId: conversationTurn.ownerId
            })
            return
          }
        }
        yield* wakeConversationTurn(composition, {
          ownerId: conversationTurn.ownerId,
          wakeAt: transition.wakeAt
        })
        return
      }
      if (
        (yield* promiseEffect(() =>
          composition.interfaces.turns.currentRevision(conversationTurn.turnId)
        )) !== conversationTurn.revision
      ) {
        yield* suppressStaleAgentAttempt(composition, {
          result,
          attemptId: runAttemptId,
          turn: conversationTurn,
          feature
        })
        return
      }
      const response = selectAgentResponse(result, agentRequest)
      const outboxTelemetry = {
        correlationId: claimed.correlationId,
        feature,
        runId: agentRequest.runId
      }
      const outboxId = yield* withBobSpan(
        {
          name: "bob.outbox.create",
          correlationId: claimed.correlationId,
          feature,
          runId: agentRequest.runId
        },
        promiseEffect(() =>
          composition.interfaces.runs.completeWithResponse(
            result,
            agentResponseInput(
              claimed.channelId,
              response.text,
              response.reasonCode,
              response.artifact,
              replyToMessageHandle
            ),
            {
              conversationTurnId: conversationTurn.turnId,
              conversationTurnRevision: conversationTurn.revision
            },
            runAttemptId
          )
        )
      )
      if (outboxId === undefined) return
      const committed = yield* withBobSpan(
        {
          name: "bob.reply.commit",
          correlationId: claimed.correlationId,
          runId: agentRequest.runId,
          conversationTurnId: conversationTurn.turnId,
          conversationRevision: conversationTurn.revision,
          feature
        },
        promiseEffect(() =>
          composition.interfaces.turns.commitReply(
            conversationTurn.turnId,
            conversationTurn.revision,
            agentRequest.runId,
            outboxId
          )
        )
      )
      if (committed === "superseded") {
        yield* withBobSpan(
          {
            name: "bob.reply.suppress",
            correlationId: claimed.correlationId,
            runId: agentRequest.runId,
            conversationTurnId: conversationTurn.turnId,
            conversationRevision: conversationTurn.revision,
            feature
          },
          Effect.gen(function* () {
            yield* recordDecision({
              name: "bob.decision.steering",
              code: "stale_reply_suppressed",
              outcome: "applied",
              conversationRevision: conversationTurn.revision
            })
            yield* releaseSettlingTurn(composition, {
              turnId: conversationTurn.turnId,
              activeRunId: agentRequest.runId,
              ownerId: claimed.ownerId
            })
          })
        )
        return
      }
      yield* promiseEffect(() =>
        composition.interfaces.turns.markEventsProcessed(
          conversationTurn.turnId,
          conversationTurn.revision
        )
      )
      yield* publishOutbox(outboundPublisher, composition, outboxId, outboxTelemetry)
    })
  )
  const workflow = withBobSpan(
    {
      name: "bob.turn.reflect",
      correlationId,
      conversationTurnId: conversationTurn.turnId,
      conversationRevision: conversationTurn.revision,
      feature: "assistant"
    },
    process
  )
  const program = withTraceparent(workflow, conversationTurn.latest.traceparent)

  return program.pipe(Effect.ensuring(Effect.suspend(() => interactionStop)))
}

export async function processConversationTurn(
  conversationTurn: ConversationTurnSnapshot,
  bindings: CoreBindings,
  core: CoreComposition
): Promise<void> {
  const ensured = processConversationTurnEffect(conversationTurn, bindings, core)
  await Effect.runPromise(
    ensured.pipe(Effect.provide(core.layer), Effect.provide(noopTelemetryLayer))
  )
}
