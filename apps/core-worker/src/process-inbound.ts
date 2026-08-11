import type { OutboundJob } from "@bob/contracts/jobs"
import type { TelemetryFeature } from "@bob/observability/events"

import { AgentRunResult, type AgentRunRequest } from "@bob/contracts/agent"
import { agentRunSpanCode, featureForTools } from "@bob/observability/attribution"
import {
  observeSpan,
  formatTraceparent,
  parseTraceparent,
  traceContextFromCorrelationId,
  traceHeaders,
  type TraceContext
} from "@bob/observability/trace"
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

interface WorkflowTelemetry {
  readonly correlationId: string
  readonly parent: TraceContext
  readonly feature: TelemetryFeature
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

async function publishOutbox(
  bindings: CoreBindings,
  composition: CoreComposition,
  outboxId: string,
  telemetry?: WorkflowTelemetry
): Promise<void> {
  const publish = async (trace?: TraceContext) => {
    await bindings.OUTBOUND_QUEUE.send({
      outboxId,
      ...(trace === undefined ? {} : { traceparent: formatTraceparent(trace) })
    } satisfies OutboundJob)
    await composition.services.delivery.markEnqueued(outboxId, new Date().toISOString())
  }
  if (telemetry === undefined) return publish()
  return observeSpan(
    {
      sink: composition.services.events,
      correlationId: telemetry.correlationId,
      parent: telemetry.parent,
      name: "outbox.publish",
      feature: telemetry.feature,
      workflow: "outbound_delivery",
      failureCode: "queue_publish"
    },
    publish
  )
}

async function enqueueOutbox(
  bindings: CoreBindings,
  composition: CoreComposition,
  input: {
    ownerId: string
    channelId: string
    text: string
    reasonCode: string
    correlationId: string
    idempotencyKey: string
  }
): Promise<string> {
  const root = traceContextFromCorrelationId(input.correlationId)
  const feature = featureForReason(input.reasonCode)
  let publishParent = root
  const outboxId = await observeSpan(
    {
      sink: composition.services.events,
      correlationId: input.correlationId,
      parent: root,
      name: "outbox.create",
      feature,
      workflow: "outbound_delivery",
      failureCode: "durable_store"
    },
    async (trace) => {
      publishParent = trace
      return composition.services.delivery.createOutbox(input)
    }
  )
  await publishOutbox(bindings, composition, outboxId, {
    correlationId: input.correlationId,
    parent: publishParent,
    feature
  })
  return outboxId
}

async function deterministicReply(
  bindings: CoreBindings,
  composition: CoreComposition,
  claimed: NonNullable<
    Awaited<ReturnType<CoreComposition["services"]["conversations"]["claimInbound"]>>
  >
): Promise<boolean> {
  const urgent = urgentSafetyResponse(claimed.text)
  if (urgent !== undefined) {
    await enqueueOutbox(bindings, composition, {
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
    await composition.services.training.stopActiveForSafety(
      claimed.ownerId,
      trainingSignal,
      `inbound:${claimed.eventId}:training-safety-stop`
    )
    await enqueueOutbox(bindings, composition, {
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
  if (command === undefined) return false
  const language = deterministicCommandLanguage(claimed.text)
  const swedish = language === "sv"
  let response: string
  switch (command) {
    case "help":
      response = fixedHelpText(language)
      break
    case "journal": {
      const handoff = await composition.services.journal.createHandoff(
        claimed.ownerId,
        10 * 60_000,
        `inbound:${claimed.eventId}:journal-handoff`
      )
      response = swedish
        ? `Öppna din privata dagbok: ${composition.config.UI_BASE_URL}/journal/${handoff.id}`
        : `Open your private journal: ${composition.config.UI_BASE_URL}/journal/${handoff.id}`
      break
    }
    case "done":
    case "seen": {
      const bindingsForReply = await composition.services.conversations.pendingBindings(
        claimed.ownerId,
        command,
        new Date().toISOString()
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
        const applied = await composition.services.reminders.applyBoundReply(
          claimed.ownerId,
          resolution.binding.id,
          command
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
  await enqueueOutbox(bindings, composition, {
    ownerId: claimed.ownerId,
    channelId: claimed.channelId,
    text: response,
    reasonCode: `command_${command}`,
    correlationId: claimed.correlationId,
    idempotencyKey: `inbound:${claimed.eventId}:command`
  })
  return true
}

export async function processInbound(
  eventId: string,
  bindings: CoreBindings,
  composition: CoreComposition,
  traceparent?: string
): Promise<void> {
  const claimed = await composition.services.conversations.claimInbound(eventId, 90_000)
  if (claimed === undefined) return
  if (await deterministicReply(bindings, composition, claimed)) {
    await composition.services.conversations.completeInbound(eventId, new Date().toISOString())
    return
  }

  const rootTrace =
    parseTraceparent(traceparent) ?? traceContextFromCorrelationId(claimed.correlationId)
  let stageParent = rootTrace
  const stored = await composition.services.runs.loadForInbound(claimed.eventId)
  if (stored?.outboxId !== undefined) {
    await publishOutbox(bindings, composition, stored.outboxId, {
      correlationId: claimed.correlationId,
      parent: rootTrace,
      feature: featureForTools(stored.request.allowedTools)
    })
    return
  }
  let request: AgentRunRequest | undefined = stored?.request
  if (request === undefined) {
    const ownerSettings = await composition.services.settings.get(claimed.ownerId)
    const localTime = new Date().toISOString()
    const runId = crypto.randomUUID()
    const allowedTools = selectTools(claimed.text)
    const feature = featureForTools(allowedTools)
    const retrievalStartedAt = Date.now()
    let contextItems: AgentRunRequest["contextItems"]
    try {
      contextItems = await observeSpan(
        {
          sink: composition.services.events,
          correlationId: claimed.correlationId,
          parent: rootTrace,
          name: "context.build",
          feature,
          workflow: "agent_turn",
          failureCode: "retrieval"
        },
        async (trace) => {
          stageParent = trace
          return composition.services.context.build({
            ownerId: claimed.ownerId,
            channelId: claimed.channelId,
            currentMessageId: claimed.messageId,
            currentUserText: claimed.text,
            localTime,
            timeZone: ownerSettings.timeZone
          })
        }
      )
      await emitSafely(composition, {
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
    } catch (error) {
      await emitSafely(composition, {
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
      throw error
    }
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
  const feature = featureForTools(request.allowedTools)
  const created =
    stored === undefined
      ? await composition.services.runs.create(request, claimed.eventId)
      : { runId: request.runId, duplicate: true }

  if (stored?.status === "completed" || stored?.status === "failed") {
    const recovered: AgentRunResult = {
      protocolVersion: 1,
      runId: request.runId,
      correlationId: request.correlationId,
      status: "failed",
      errorCode: "provider",
      model: composition.config.BOB_MODEL,
      durationMs: 0,
      inputTokens: 0,
      outputTokens: 0,
      toolCalls: 0
    }
    let publishParent = stageParent
    const outboxId = await observeSpan(
      {
        sink: composition.services.events,
        correlationId: claimed.correlationId,
        parent: stageParent,
        name: "outbox.create",
        feature,
        workflow: "outbound_delivery",
        failureCode: "durable_store"
      },
      async (trace) => {
        publishParent = trace
        return composition.services.runs.completeWithResponse(recovered, {
          channelId: claimed.channelId,
          text: "I recovered your request, but its prior response was unavailable. I made no automatic provider change.",
          reasonCode: "agent_recovery"
        })
      }
    )
    await publishOutbox(bindings, composition, outboxId, {
      correlationId: claimed.correlationId,
      parent: publishParent,
      feature
    })
    return
  }
  if (!(await composition.services.runs.claim(created.runId, 90_000))) return

  const program = Effect.tryPromise({
    try: async (signal) => {
      return observeSpan(
        {
          sink: composition.services.events,
          correlationId: claimed.correlationId,
          parent: stageParent,
          name: "model.run",
          feature,
          workflow: "agent_turn",
          failureCode: "provider",
          errorCode: (error) =>
            error instanceof AgentCallError
              ? (agentRunSpanCode("failed", error.code) ?? "provider")
              : "provider"
        },
        async (trace) => {
          const response = await fetch(`${composition.config.AGENT_URL}/v1/run`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "CF-Access-Client-Id": composition.config.AGENT_ACCESS_CLIENT_ID,
              "CF-Access-Client-Secret": composition.config.AGENT_ACCESS_CLIENT_SECRET,
              ...traceHeaders(trace),
              "x-bob-correlation-id": claimed.correlationId
            },
            body: JSON.stringify(request),
            signal
          })
          stageParent = parseTraceparent(response.headers.get("traceparent")) ?? trace
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
        (result) => agentRunSpanCode(result.status, result.errorCode)
      )
    },
    catch: (error) => (error instanceof AgentCallError ? error : new AgentCallError("provider"))
  }).pipe(Effect.timeout(request.limits.maxDurationMs + 5_000))

  let result: AgentRunResult
  try {
    result = await Effect.runPromise(program)
  } catch (error) {
    const errorCode =
      error instanceof AgentCallError
        ? error.code
        : typeof error === "object" &&
            error !== null &&
            Reflect.get(error, "_tag") === "TimeoutException"
          ? "timeout"
          : "provider"
    result = {
      protocolVersion: 1,
      runId: request.runId,
      correlationId: claimed.correlationId,
      status: "failed",
      errorCode,
      model: composition.config.BOB_MODEL,
      durationMs: request.limits.maxDurationMs,
      inputTokens: 0,
      outputTokens: 0,
      toolCalls: 0
    }
  }
  const response = selectAgentResponse(result, request)
  await reportAgentUsage(
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
  await reportAgentFailure(composition.services.alerts, claimed.ownerId, result)
  let publishParent = stageParent
  const outboxId = await observeSpan(
    {
      sink: composition.services.events,
      correlationId: claimed.correlationId,
      parent: stageParent,
      name: "outbox.create",
      feature,
      workflow: "outbound_delivery",
      failureCode: "durable_store"
    },
    async (trace) => {
      publishParent = trace
      return composition.services.runs.completeWithResponse(result, {
        channelId: claimed.channelId,
        text: response.text,
        reasonCode: response.reasonCode
      })
    }
  )
  await publishOutbox(bindings, composition, outboxId, {
    correlationId: claimed.correlationId,
    parent: publishParent,
    feature
  })
}
