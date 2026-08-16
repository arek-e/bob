import type { OutboundJob } from "@bob/contracts/jobs"

import { AgentRunResult, type AgentArtifact, type AgentRunRequest } from "@bob/contracts/agent"
import { requiresPersonalGrounding } from "@bob/contracts/output-safety"
import { featureForTools } from "@bob/observability/attribution"
import {
  recordDecision,
  withBobSpan,
  type BobDecisionCode,
  type BobSpan
} from "@bob/observability/effect"
import { observeHealth, type TelemetryFeature } from "@bob/observability/events"
import {
  externalParentFromTraceparent,
  formatTraceparent,
  injectCurrentTraceparent
} from "@bob/observability/propagation"
import { Effect, Schema } from "effect"

import type { CoreBindings } from "./bindings.ts"
import type { CoreComposition } from "./composition.ts"
import type { ConversationTurnSnapshot } from "./modules/conversations/turn-store.ts"

import { conversationTiming } from "./modules/conversations/timing.ts"
import { reportAgentFailure, reportAgentUsage } from "./modules/observability/reporting.ts"
import { selectAgentResponse } from "./modules/policy/agent-response.ts"
import {
  classifyDeterministicCommand,
  deterministicCommandLanguage,
  fixedHelpText,
  isArtifactResendRequest,
  urgentSafetyResponse
} from "./modules/policy/rules.ts"

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

export interface CoreWorkflowTelemetryRunner {
  readonly runPromise: <A, E>(effect: Effect.Effect<A, E>) => Promise<A>
}

function promiseEffect<A>(operation: (signal: AbortSignal) => PromiseLike<A> | A) {
  return Effect.tryPromise({
    try: (signal) => Promise.resolve(operation(signal)),
    catch: (error) => error
  })
}

function withTraceparentParent<A, E>(
  traceparent: string | undefined,
  effect: Effect.Effect<A, E>
): Effect.Effect<A, E> {
  const parent = externalParentFromTraceparent(traceparent)
  return parent === undefined ? effect : Effect.withParentSpan(effect, parent)
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
  bindings: CoreBindings,
  input: { readonly ownerId: string; readonly wakeAt?: string }
) {
  return promiseEffect(async () => {
    try {
      const coordinators = bindings.OWNER_RUN_COORDINATOR.jurisdiction("eu")
      const url = new URL("https://coordinator.internal/wake")
      if (input.wakeAt !== undefined) url.searchParams.set("at", input.wakeAt)
      await coordinators.get(coordinators.idFromName(input.ownerId)).fetch(url, { method: "POST" })
    } catch {
      // The durable turn state remains recoverable after a lost live wake-up.
    }
  })
}

function releaseSettlingTurn(
  bindings: CoreBindings,
  composition: CoreComposition,
  input: { readonly turnId: string; readonly activeRunId: string; readonly ownerId: string }
) {
  return Effect.gen(function* () {
    const released = yield* promiseEffect(() =>
      composition.services.turns.releaseSettling(input.turnId, input.activeRunId)
    )
    if (!released.ready) return released
    yield* wakeConversationTurn(bindings, { ownerId: input.ownerId })
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
  bindings: CoreBindings,
  composition: CoreComposition,
  outboxId: string,
  telemetry: OutboxTelemetry
) {
  return withBobSpan(
    outboxSpan("bob.outbox.publish", telemetry, outboxId),
    Effect.gen(function* () {
      const span = yield* Effect.currentSpan
      yield* promiseEffect(() =>
        bindings.OUTBOUND_QUEUE.send({
          outboxId,
          dispatchGeneration: 0,
          correlationId: telemetry.correlationId,
          traceparent: formatTraceparent(span)
        } satisfies OutboundJob)
      )
      yield* promiseEffect(() =>
        composition.services.delivery.markEnqueued(outboxId, new Date().toISOString(), 0)
      )
    })
  )
}

type ClaimedInbound = NonNullable<
  Awaited<ReturnType<CoreComposition["services"]["conversations"]["claimInbound"]>>
>

function nativeReplyTarget(claimed: ClaimedInbound): string | undefined {
  return claimed.service === "imessage" && !claimed.isGroup
    ? claimed.providerMessageHandle
    : undefined
}

function messageInteractionLifecycle(composition: CoreComposition, claimed: ClaimedInbound) {
  const eligible = nativeReplyTarget(claimed) !== undefined
  const egressUrl = composition.config.SENDBLUE_EGRESS_URL
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
        composition.services.conversations.claimReaction(claimed.eventId, new Date().toISOString())
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
  composition: CoreComposition,
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

    for (const workflow of composition.runtime.conversations) {
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
          composition.services.artifacts.latest(claimed.ownerId, claimed.channelId)
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
          "Sendblue manages opt-out words. Bob will stop messages after Sendblue confirms opt-out."
        break
      case "start":
        response = "Sendblue manages START. Bob resumes only after Sendblue confirms the change."
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
  bindings: CoreBindings,
  composition: CoreComposition,
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
        composition.services.runs.completeWithoutResponse(input.result, input.attemptId)
      )
      if (!suppressed) return false
      yield* releaseSettlingTurn(bindings, composition, {
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
  composition: CoreComposition,
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
        "CF-Access-Client-Id": composition.config.AGENT_ACCESS_CLIENT_ID,
        "CF-Access-Client-Secret": composition.config.AGENT_ACCESS_CLIENT_SECRET,
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

export async function processConversationTurn(
  conversationTurn: ConversationTurnSnapshot,
  bindings: CoreBindings,
  composition: CoreComposition,
  telemetry?: CoreWorkflowTelemetryRunner
): Promise<void> {
  const correlationId = conversationTurn.latest.correlationId
  const runTelemetry = telemetry?.runPromise ?? Effect.runPromise
  let interactionStop: Effect.Effect<void> = Effect.void
  const process = withBobSpan(
    {
      name: "bob.inbound.process",
      correlationId,
      feature: "assistant"
    },
    Effect.gen(function* () {
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
        releaseSettlingTurn(bindings, composition, {
          turnId: turn.turnId,
          activeRunId: deterministicRunId,
          ownerId: claimed.ownerId
        }).pipe(Effect.asVoid)
      const beginDeterministic = () =>
        Effect.gen(function* () {
          const started = yield* promiseEffect(() =>
            composition.services.turns.markRunning(turn.turnId, turn.revision, deterministicRunId)
          )
          if (!started) return false
          const currentRevision = yield* promiseEffect(() =>
            composition.services.turns.currentRevision(turn.turnId)
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
              composition.services.turns.currentRevision(turn.turnId)
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
              composition.services.delivery.createOutbox({
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
              composition.services.turns.commitReply(
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
            composition.services.turns.markEventsProcessed(turn.turnId, turn.revision)
          )
          yield* publishOutbox(bindings, composition, outboxId, {
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
        composition.services.runs.loadForTurn(conversationTurn.turnId, conversationTurn.revision)
      )

      let request: AgentRunRequest | undefined = stored?.request
      if (request === undefined) {
        const ownerSettings = yield* promiseEffect(() =>
          composition.services.settings.get(claimed.ownerId)
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
            promiseEffect(() => composition.services.context.build(contextBuildRequest))
          )
        ).pipe(
          Effect.tap((contextItems) =>
            Effect.promise(() =>
              observeHealth(composition.services.events, {
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
            )
          ),
          Effect.tapError(() =>
            Effect.promise(() =>
              observeHealth(composition.services.events, {
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
        )
        const contextItems = yield* retrieve
        const priorToolReceipts = yield* promiseEffect(
          () => composition.services.context.priorToolReceipts?.(contextBuildRequest) ?? []
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
          ? promiseEffect(() => composition.services.runs.create(agentRequest, claimed.eventId))
          : Effect.succeed({ runId: agentRequest.runId, duplicate: true })
      )

      if (
        !(yield* promiseEffect(() =>
          composition.services.turns.markRunning(
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
          composition.services.turns.commitReply(
            conversationTurn.turnId,
            conversationTurn.revision,
            stored.request.runId,
            storedOutboxId
          )
        )
        if (committed === "superseded") {
          yield* releaseSettlingTurn(bindings, composition, {
            turnId: conversationTurn.turnId,
            activeRunId: stored.request.runId,
            ownerId: claimed.ownerId
          })
          return
        }
        yield* promiseEffect(() =>
          composition.services.turns.markEventsProcessed(
            conversationTurn.turnId,
            conversationTurn.revision
          )
        )
        yield* publishOutbox(bindings, composition, storedOutboxId, {
          correlationId: claimed.correlationId,
          feature,
          runId: stored.request.runId
        })
        return
      }

      const runAttemptId = yield* promiseEffect(() =>
        composition.services.runs.claim(created.runId, conversationTiming.activeLeaseMs)
      )
      yield* recordDecision({
        name: "bob.decision.idempotency",
        code: runAttemptId === undefined ? "in_progress" : "allowed",
        outcome: runAttemptId === undefined ? "skipped" : "allowed"
      })
      if (runAttemptId === undefined) return

      if (
        (yield* promiseEffect(() =>
          composition.services.turns.currentRevision(conversationTurn.turnId)
        )) !== conversationTurn.revision
      ) {
        yield* suppressStaleAgentAttempt(bindings, composition, {
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
          composition.services.tools?.mutationActivity?.(agentRequest.runId) ?? { status: "none" }
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
          composition.services.tools.expireMutationRecovery(agentRequest.runId)
        )
        mutationActivity = yield* promiseEffect(() =>
          composition.services.tools.mutationActivity(agentRequest.runId)
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
            composition.services.turns.currentRevision(conversationTurn.turnId)
          )) !== conversationTurn.revision
        ) {
          yield* suppressStaleAgentAttempt(bindings, composition, {
            result,
            attemptId: runAttemptId,
            turn: conversationTurn,
            feature
          })
          return
        }
        const retry = yield* promiseEffect(() =>
          composition.services.runs.releaseForRetry(
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
            bindings,
            retry.wakeAt === undefined
              ? { ownerId: conversationTurn.ownerId }
              : { ownerId: conversationTurn.ownerId, wakeAt: retry.wakeAt }
          )
          return
        }
      }
      yield* promiseEffect(() =>
        reportAgentUsage(
          composition.database,
          composition.services.alerts,
          composition.services.events,
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
        reportAgentFailure(composition.services.alerts, claimed.ownerId, result)
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
          composition.services.runs.completeForReflection(
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
            composition.services.tools.mutationActivity(agentRequest.runId)
          )
          if (settledActivity.status !== "active") {
            yield* releaseSettlingTurn(bindings, composition, {
              turnId: conversationTurn.turnId,
              activeRunId: agentRequest.runId,
              ownerId: conversationTurn.ownerId
            })
            return
          }
        }
        yield* wakeConversationTurn(bindings, {
          ownerId: conversationTurn.ownerId,
          wakeAt: transition.wakeAt
        })
        return
      }
      if (
        (yield* promiseEffect(() =>
          composition.services.turns.currentRevision(conversationTurn.turnId)
        )) !== conversationTurn.revision
      ) {
        yield* suppressStaleAgentAttempt(bindings, composition, {
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
          composition.services.runs.completeWithResponse(
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
          composition.services.turns.commitReply(
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
            yield* releaseSettlingTurn(bindings, composition, {
              turnId: conversationTurn.turnId,
              activeRunId: agentRequest.runId,
              ownerId: claimed.ownerId
            })
          })
        )
        return
      }
      yield* promiseEffect(() =>
        composition.services.turns.markEventsProcessed(
          conversationTurn.turnId,
          conversationTurn.revision
        )
      )
      yield* publishOutbox(bindings, composition, outboxId, outboxTelemetry)
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
  const program = withTraceparentParent(conversationTurn.latest.traceparent, workflow)

  await runTelemetry(program.pipe(Effect.ensuring(Effect.suspend(() => interactionStop))))
}
