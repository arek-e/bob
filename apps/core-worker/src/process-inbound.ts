import type { OutboundJob } from "@bob/contracts/jobs"
import type { TelemetryFeature } from "@bob/observability/events"

import { AgentRunResult, type AgentRunRequest } from "@bob/contracts/agent"
import { featureForTools } from "@bob/observability/attribution"
import { recordDecision, withBobSpan, type BobDecisionCode } from "@bob/observability/effect"
import {
  externalParentFromTraceparent,
  formatTraceparent,
  injectCurrentTraceparent
} from "@bob/observability/propagation"
import { Effect, Schema } from "effect"

import type { CoreBindings } from "./bindings.ts"
import type { CoreComposition } from "./composition.ts"

import { selectTools } from "./modules/context/tool-selection.ts"
import { reportAgentFailure, reportAgentUsage } from "./modules/observability/reporting.ts"
import { selectAgentResponse } from "./modules/policy/agent-response.ts"
import {
  classifyDeterministicCommand,
  deterministicCommandLanguage,
  fixedHelpText,
  resolveShortReply,
  urgentSafetyResponse
} from "./modules/policy/rules.ts"
import { trainingSafetyResponse, trainingSafetySignal } from "./modules/training/rules.ts"

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

async function emitSafely(
  composition: CoreComposition,
  event: Parameters<CoreComposition["services"]["events"]["emit"]>[0]
) {
  try {
    await composition.services.events.emit(event)
  } catch {
    // Telemetry must not change a durable workflow.
  }
}

function featureForReason(reasonCode: string): TelemetryFeature {
  if (
    reasonCode.includes("reminder") ||
    reasonCode.includes("command_done") ||
    reasonCode.includes("command_seen")
  ) {
    return "reminders"
  }
  if (reasonCode.includes("journal")) return "journal"
  if (reasonCode.includes("safety")) return "safety"
  if (reasonCode.includes("training")) return "training"
  return "assistant"
}

interface OutboxTelemetry {
  readonly correlationId: string
  readonly feature: TelemetryFeature
  readonly runId?: string
}

function publishOutbox(
  bindings: CoreBindings,
  composition: CoreComposition,
  outboxId: string,
  telemetry: OutboxTelemetry
) {
  return withBobSpan(
    {
      name: "bob.outbox.publish",
      correlationId: telemetry.correlationId,
      feature: telemetry.feature,
      outboxId,
      ...(telemetry.runId === undefined ? {} : { runId: telemetry.runId })
    },
    Effect.gen(function* () {
      const span = yield* Effect.currentSpan
      yield* promiseEffect(() =>
        bindings.OUTBOUND_QUEUE.send({
          outboxId,
          correlationId: telemetry.correlationId,
          traceparent: formatTraceparent(span)
        } satisfies OutboundJob)
      )
      yield* promiseEffect(() =>
        composition.services.delivery.markEnqueued(outboxId, new Date().toISOString())
      )
    })
  )
}

function createAndPublishOutbox(
  bindings: CoreBindings,
  composition: CoreComposition,
  telemetry: OutboxTelemetry,
  create: () => Promise<string>
) {
  return withBobSpan(
    {
      name: "bob.outbox.create",
      correlationId: telemetry.correlationId,
      feature: telemetry.feature,
      ...(telemetry.runId === undefined ? {} : { runId: telemetry.runId })
    },
    Effect.gen(function* () {
      const outboxId = yield* promiseEffect(create)
      yield* publishOutbox(bindings, composition, outboxId, telemetry)
      return outboxId
    })
  )
}

function enqueueOutbox(
  bindings: CoreBindings,
  composition: CoreComposition,
  input: {
    ownerId: string
    channelId: string
    text: string
    reasonCode: string
    correlationId: string
    idempotencyKey: string
  },
  runId?: string
) {
  return createAndPublishOutbox(
    bindings,
    composition,
    {
      correlationId: input.correlationId,
      feature: featureForReason(input.reasonCode),
      ...(runId === undefined ? {} : { runId })
    },
    () => composition.services.delivery.createOutbox(input)
  )
}

type ClaimedInbound = NonNullable<
  Awaited<ReturnType<CoreComposition["services"]["conversations"]["claimInbound"]>>
>

function deterministicReply(
  bindings: CoreBindings,
  composition: CoreComposition,
  claimed: ClaimedInbound
) {
  return Effect.gen(function* () {
    const urgent = urgentSafetyResponse(claimed.text)
    if (urgent !== undefined) {
      yield* recordDecision({
        name: "bob.decision.route",
        code: "urgent_safety",
        outcome: "selected"
      })
      yield* enqueueOutbox(bindings, composition, {
        ownerId: claimed.ownerId,
        channelId: claimed.channelId,
        text: urgent,
        reasonCode: "urgent_safety",
        correlationId: claimed.correlationId,
        idempotencyKey: `inbound:${claimed.eventId}:urgent`
      })
      return true
    }

    const trainingSignal = trainingSafetySignal(claimed.text)
    if (trainingSignal !== undefined) {
      yield* recordDecision({
        name: "bob.decision.route",
        code: "training_safety",
        outcome: "selected"
      })
      yield* promiseEffect(() =>
        composition.services.training.stopActiveForSafety(
          claimed.ownerId,
          trainingSignal,
          `inbound:${claimed.eventId}:training-safety-stop`
        )
      )
      yield* enqueueOutbox(bindings, composition, {
        ownerId: claimed.ownerId,
        channelId: claimed.channelId,
        text: trainingSafetyResponse(claimed.text)!,
        reasonCode: "training_safety_stop",
        correlationId: claimed.correlationId,
        idempotencyKey: `inbound:${claimed.eventId}:training-safety-reply`
      })
      return true
    }

    const command = classifyDeterministicCommand(claimed.text)
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
    const language = deterministicCommandLanguage(claimed.text)
    const swedish = language === "sv"
    let response: string
    switch (command) {
      case "help":
        response = fixedHelpText(language)
        break
      case "journal": {
        const handoff = yield* promiseEffect(() =>
          composition.services.journal.createHandoff(
            claimed.ownerId,
            10 * 60_000,
            `inbound:${claimed.eventId}:journal-handoff`
          )
        )
        response = swedish
          ? `Öppna din privata dagbok: ${composition.config.UI_BASE_URL}/journal/${handoff.id}`
          : `Open your private journal: ${composition.config.UI_BASE_URL}/journal/${handoff.id}`
        break
      }
      case "done":
      case "seen": {
        const bindingsForReply = yield* promiseEffect(() =>
          composition.services.conversations.pendingBindings(
            claimed.ownerId,
            command,
            new Date().toISOString()
          )
        )
        const resolution = resolveShortReply(command, bindingsForReply, new Date())
        if (resolution.kind === "ambiguous") {
          response = swedish
            ? "Fler än en åtgärd matchar. Öppna Bob och välj rätt post."
            : "More than one action matches. Open Bob to choose the correct item."
        } else if (resolution.kind === "none") {
          response = swedish
            ? `Jag kan inte koppla ${claimed.text.trim().toUpperCase()} till en aktuell post.`
            : `I cannot match ${command.toUpperCase()} to one current item.`
        } else if (resolution.binding.targetType !== "reminder") {
          response = swedish
            ? "Svaret är inte kopplat till en påminnelse. Öppna Bob och välj posten."
            : "That reply is not linked to a reminder. Open Bob to choose the item."
        } else {
          const applied = yield* promiseEffect(() =>
            composition.services.reminders.applyBoundReply(
              claimed.ownerId,
              resolution.binding.id,
              command
            )
          )
          response =
            applied === "invalid"
              ? swedish
                ? "Åtgärden är inte längre tillgänglig. Öppna Bob och välj posten."
                : "That action is no longer available. Open Bob to choose the item."
              : command === "done"
                ? swedish
                  ? "Påminnelsen är markerad som klar."
                  : "Marked complete."
                : swedish
                  ? "Påminnelsen är markerad som sedd."
                  : "Marked as seen."
        }
        break
      }
      case "stop":
      case "cancel":
        response =
          "Sendblue manages opt-out words. Bob will stop messages after Sendblue confirms opt-out."
        break
      case "start":
        response = "Sendblue manages START. Bob resumes only after Sendblue confirms the change."
        break
      case "repeat":
        response = swedish
          ? "Öppna Bob för att se det senaste meddelandet."
          : "Open Bob to view the last message."
        break
      case "why":
        response = swedish
          ? "Öppna Bob för att se den sparade orsaken och källan för den senaste påminnelsen."
          : "Open Bob to view the stored reason and source for the last reminder."
        break
      case "pause":
        response = swedish
          ? "Den här interaktionen är pausad. Dina schemalagda påminnelser ändras inte."
          : "This interaction is paused. Your scheduled reminders are unchanged."
        break
      case "undo":
        response = swedish
          ? "Jag kan inte koppla ÅNGRA till en säker omvänd åtgärd. Öppna Bob och välj en post."
          : "I cannot match UNDO to one safe inverse action. Open Bob to choose an item."
        break
    }
    yield* enqueueOutbox(bindings, composition, {
      ownerId: claimed.ownerId,
      channelId: claimed.channelId,
      text: response,
      reasonCode: `command_${command}`,
      correlationId: claimed.correlationId,
      idempotencyKey: `inbound:${claimed.eventId}:command`
    })
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

function agentCallErrorCode(error: unknown): NonNullable<AgentRunResult["errorCode"]> {
  if (error instanceof AgentCallError) return error.code
  if (
    typeof error === "object" &&
    error !== null &&
    Reflect.get(error, "_tag") === "TimeoutException"
  ) {
    return "timeout"
  }
  return "provider"
}

function failedAgentResult(
  request: AgentRunRequest,
  model: string,
  error: unknown
): AgentRunResult {
  return {
    protocolVersion: 1,
    runId: request.runId,
    correlationId: request.correlationId,
    status: "failed",
    errorCode: agentCallErrorCode(error),
    model,
    durationMs: request.limits.maxDurationMs,
    inputTokens: 0,
    outputTokens: 0,
    toolCalls: 0
  }
}

function invokeAgent(
  request: AgentRunRequest,
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
        "x-bob-correlation-id": request.correlationId
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
        Effect.timeout(request.limits.maxDurationMs + 5_000),
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

export async function processInbound(
  eventId: string,
  bindings: CoreBindings,
  composition: CoreComposition,
  traceparent?: string,
  telemetry?: CoreWorkflowTelemetryRunner,
  correlationId = eventId
): Promise<void> {
  const runTelemetry = telemetry?.runPromise ?? Effect.runPromise
  const program = withTraceparentParent(
    traceparent,
    withBobSpan(
      {
        name: "bob.inbound.process",
        correlationId,
        feature: "assistant"
      },
      Effect.gen(function* () {
        const claimed = yield* withBobSpan(
          {
            name: "bob.inbound.claim",
            correlationId,
            feature: "assistant"
          },
          promiseEffect(() => composition.services.conversations.claimInbound(eventId, 90_000))
        )
        if (claimed === undefined) {
          yield* recordDecision({
            name: "bob.decision.route",
            code: "external_unknown",
            outcome: "skipped"
          })
          return
        }

        if (yield* deterministicReply(bindings, composition, claimed)) {
          yield* promiseEffect(() =>
            composition.services.conversations.completeInbound(eventId, new Date().toISOString())
          )
          return
        }

        const stored = yield* promiseEffect(() =>
          composition.services.runs.loadForInbound(claimed.eventId)
        )
        if (stored?.outboxId !== undefined) {
          yield* publishOutbox(bindings, composition, stored.outboxId, {
            correlationId: claimed.correlationId,
            feature: featureForTools(stored.request.allowedTools),
            runId: stored.request.runId
          })
          return
        }

        let request: AgentRunRequest | undefined = stored?.request
        if (request === undefined) {
          const ownerSettings = yield* promiseEffect(() =>
            composition.services.settings.get(claimed.ownerId)
          )
          const localTime = new Date().toISOString()
          const runId = crypto.randomUUID()
          const allowedTools = selectTools(claimed.text)
          const feature = featureForTools(allowedTools)
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
              promiseEffect(() =>
                composition.services.context.build({
                  ownerId: claimed.ownerId,
                  channelId: claimed.channelId,
                  currentMessageId: claimed.messageId,
                  currentUserText: claimed.text,
                  localTime,
                  timeZone: ownerSettings.timeZone
                })
              )
            )
          ).pipe(
            Effect.tap((contextItems) =>
              Effect.promise(() =>
                emitSafely(composition, {
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
                emitSafely(composition, {
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
          request = {
            protocolVersion: 1,
            runId,
            ownerId: claimed.ownerId,
            correlationId: claimed.correlationId,
            sourceMessageId: claimed.messageId,
            localTime,
            timeZone: ownerSettings.timeZone,
            locale: ownerSettings.locale,
            hourCycle: ownerSettings.hourCycle,
            userText: claimed.text,
            contextItems,
            allowedTools,
            limits: {
              maxTurns: 4,
              maxToolCalls: 4,
              maxDurationMs: 60_000,
              maxResponseCharacters: 1_200
            }
          }
        }

        const agentRequest = request
        const feature = featureForTools(agentRequest.allowedTools)
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

        if (stored?.status === "completed" || stored?.status === "failed") {
          const recovered: AgentRunResult = {
            protocolVersion: 1,
            runId: agentRequest.runId,
            correlationId: agentRequest.correlationId,
            status: "failed",
            errorCode: "provider",
            model: composition.config.BOB_MODEL,
            durationMs: 0,
            inputTokens: 0,
            outputTokens: 0,
            toolCalls: 0
          }
          yield* createAndPublishOutbox(
            bindings,
            composition,
            {
              correlationId: claimed.correlationId,
              feature,
              runId: agentRequest.runId
            },
            () =>
              composition.services.runs.completeWithResponse(recovered, {
                channelId: claimed.channelId,
                text: "I recovered your request, but its prior response was unavailable. I made no automatic provider change.",
                reasonCode: "agent_recovery"
              })
          )
          return
        }

        const runClaimed = yield* promiseEffect(() =>
          composition.services.runs.claim(created.runId, 90_000)
        )
        yield* recordDecision({
          name: "bob.decision.idempotency",
          code: runClaimed ? "allowed" : "in_progress",
          outcome: runClaimed ? "allowed" : "skipped"
        })
        if (!runClaimed) return

        const result = yield* invokeAgent(agentRequest, composition, feature).pipe(
          Effect.catch((error) =>
            Effect.succeed(failedAgentResult(agentRequest, composition.config.BOB_MODEL, error))
          )
        )
        const response = selectAgentResponse(result, agentRequest)
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
        yield* createAndPublishOutbox(
          bindings,
          composition,
          {
            correlationId: claimed.correlationId,
            feature,
            runId: agentRequest.runId
          },
          () =>
            composition.services.runs.completeWithResponse(result, {
              channelId: claimed.channelId,
              text: response.text,
              reasonCode: response.reasonCode
            })
        )
      })
    )
  )

  await runTelemetry(program)
}
