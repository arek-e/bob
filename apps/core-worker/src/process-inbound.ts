import { AgentRunResult, type AgentRunRequest } from "@bob/contracts/agent"
import type { OutboundJob } from "@bob/contracts/jobs"
import { Effect, Schema } from "effect"

import type { CoreBindings } from "./bindings.ts"
import type { CoreComposition } from "./composition.ts"
import { selectTools } from "./modules/context/tool-selection.ts"
import {
  classifyDeterministicCommand,
  fixedHelpText,
  resolveShortReply,
  urgentSafetyResponse
} from "./modules/policy/rules.ts"
import { trainingSafetySignal } from "./modules/training/rules.ts"

class AgentCallError extends Error {
  readonly _tag = "AgentCallError"
  constructor(readonly code: NonNullable<AgentRunResult["errorCode"]>) {
    super(`Agent host request failed: ${code}`)
  }
}

async function publishOutbox(
  bindings: CoreBindings,
  composition: CoreComposition,
  outboxId: string
): Promise<void> {
  await bindings.OUTBOUND_QUEUE.send({ outboxId } satisfies OutboundJob)
  await composition.services.delivery.markEnqueued(outboxId, new Date().toISOString())
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
  const outboxId = await composition.services.delivery.createOutbox(input)
  await publishOutbox(bindings, composition, outboxId)
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
      text: "Stop this exercise now. Do not increase the weight. Ask a qualified trainer or health professional for help.",
      reasonCode: "training_safety_stop",
      correlationId: claimed.correlationId,
      idempotencyKey: `inbound:${claimed.eventId}:training-safety-reply`
    })
    return true
  }

  const command = classifyDeterministicCommand(claimed.text)
  if (command === undefined) return false
  let response: string
  switch (command) {
    case "help":
      response = fixedHelpText()
      break
    case "journal": {
      const handoff = await composition.services.journal.createHandoff(
        claimed.ownerId,
        10 * 60_000,
        `inbound:${claimed.eventId}:journal-handoff`
      )
      response = `Open your private journal: ${composition.config.UI_BASE_URL}/journal/${handoff.id}`
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
        response = "More than one action matches. Open Bob to choose the correct item."
      } else if (resolution.kind === "none") {
        response = `I cannot match ${command.toUpperCase()} to one current item.`
      } else if (resolution.binding.targetType !== "reminder") {
        response = "That reply is not linked to a reminder. Open Bob to choose the item."
      } else {
        const applied = await composition.services.reminders.applyBoundReply(
          claimed.ownerId,
          resolution.binding.id,
          command
        )
        response =
          applied === "invalid"
            ? "That action is no longer available. Open Bob to choose the item."
            : command === "done"
              ? "Marked complete."
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
      response = "Open Bob to view the last message."
      break
    case "why":
      response = "Open Bob to view the stored reason and source for the last reminder."
      break
    case "pause":
      response = "This interaction is paused. Your scheduled reminders are unchanged."
      break
    case "undo":
      response = "I cannot match UNDO to one safe inverse action. Open Bob to choose an item."
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
  composition: CoreComposition
): Promise<void> {
  const claimed = await composition.services.conversations.claimInbound(eventId, 90_000)
  if (claimed === undefined) return
  if (await deterministicReply(bindings, composition, claimed)) {
    await composition.services.conversations.completeInbound(eventId, new Date().toISOString())
    return
  }

  const stored = await composition.services.runs.loadForInbound(claimed.eventId)
  if (stored?.outboxId !== undefined) {
    await publishOutbox(bindings, composition, stored.outboxId)
    return
  }
  const request: AgentRunRequest =
    stored?.request ??
    ({
      protocolVersion: 1,
      runId: crypto.randomUUID(),
      ownerId: claimed.ownerId,
      correlationId: claimed.correlationId,
      localTime: new Date().toISOString(),
      timeZone: composition.config.OWNER_TIME_ZONE,
      userText: claimed.text,
      contextItems: await composition.services.context.build(claimed.ownerId, claimed.channelId),
      allowedTools: selectTools(claimed.text),
      limits: {
        maxTurns: 4,
        maxToolCalls: 4,
        maxDurationMs: 60_000,
        maxResponseCharacters: 1_200
      }
    } satisfies AgentRunRequest)
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
    const outboxId = await composition.services.runs.completeWithResponse(recovered, {
      channelId: claimed.channelId,
      text: "I recovered your request, but its prior response was unavailable. I made no automatic provider change.",
      reasonCode: "agent_recovery"
    })
    await publishOutbox(bindings, composition, outboxId)
    return
  }
  if (!(await composition.services.runs.claim(created.runId, 90_000))) return

  const program = Effect.tryPromise({
    try: async (signal) => {
      const response = await fetch(`${composition.config.AGENT_URL}/v1/run`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "CF-Access-Client-Id": composition.config.AGENT_ACCESS_CLIENT_ID,
          "CF-Access-Client-Secret": composition.config.AGENT_ACCESS_CLIENT_SECRET
        },
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
      return Schema.decodeUnknownSync(AgentRunResult)(await response.json())
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
  const responseText =
    result.status === "completed" && result.responseText !== undefined
      ? result.responseText
      : "I could not complete that request. I did not make an automatic billing or provider change."
  if (result.status === "failed" && result.errorCode === "authentication") {
    await composition.services.alerts.record({
      ownerId: claimed.ownerId,
      code: "agent_authentication_failed",
      objectType: "agent_run",
      objectId: result.runId,
      idempotencyKey: `alert:agent-authentication:${result.runId}`
    })
  }
  const outboxId = await composition.services.runs.completeWithResponse(result, {
    channelId: claimed.channelId,
    text: responseText,
    reasonCode: result.status === "completed" ? "agent_reply" : "agent_failure"
  })
  await publishOutbox(bindings, composition, outboxId)
}
