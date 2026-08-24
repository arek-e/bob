import {
  AcquireAgentRun,
  AgentRunAttemptAuthority,
  AgentRunGateway,
  AppendAgentRunCheckpoint,
  RecordAgentRunOutcome,
  RenewAgentRunLease
} from "@bob/agent-runs-types/worker-gateway"
import {
  AgentRunOperationAppendRequest,
  AgentRunOperationsLoadRequest,
  AgentRunResult
} from "@bob/agent-types/run"
import { MessageAttachmentStore } from "@bob/conversations-types/attachment-store"
import { AgentRunStore } from "@bob/conversations-types/run-store"
import { ToolExecutor } from "@bob/conversations-types/tool-executor"
import { ConversationTurnStore } from "@bob/conversations-types/turn-store"
import { agentRuns } from "@bob/db-service/schema/conversations"
import {
  emitHealth,
  featureForToolName,
  recordDecision,
  withBobSpan,
  withTraceparent
} from "@bob/observability"
import { ToolCommand } from "@bob/tools-types/tools"
import { and, eq, isNull, sql } from "drizzle-orm"
import { Effect, Schema } from "effect"

import type { HttpRouteContext } from "../../context.ts"

import { json, secure } from "../../response.ts"
import { attachmentFailureStatus } from "./attachments.ts"

function promiseEffect<A>(operation: (signal: AbortSignal) => Promise<A>) {
  return Effect.tryPromise({ try: operation, catch: (error) => error })
}

function toolAuthority(request: Request) {
  const runId = request.headers.get("x-bob-run-id")
  const attemptId = request.headers.get("x-bob-run-attempt-id")
  const fence = request.headers.get("x-bob-run-attempt-fence")
  const revision = request.headers.get("x-bob-run-control-revision")
  if (runId === null && attemptId === null && fence === null && revision === null) return undefined
  return Schema.decodeUnknownSync(
    Schema.Struct({
      runId: Schema.String.check(Schema.isUUID()),
      attemptId: Schema.String.check(Schema.isUUID()),
      attemptFence: Schema.Int.check(Schema.isGreaterThan(0)),
      controlRevision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
    })
  )({ runId, attemptId, attemptFence: Number(fence), controlRevision: Number(revision) })
}

async function hasAgentRunResourceAuthority(
  context: HttpRouteContext,
  runId: string
): Promise<boolean> {
  const authority = toolAuthority(context.request)
  if (authority === undefined && context.composition.config?.ASYNC_AGENT_RUNS !== "true")
    return true
  const [run] = await Effect.runPromise(
    context.composition.applicationStorage
      .select({ executionPoolId: agentRuns.executionPoolId })
      .from(agentRuns)
      .where(eq(agentRuns.id, runId))
      .limit(1)
  )
  if (run?.executionPoolId === null) return true
  if (authority === undefined || authority.runId !== runId) return false
  const [authorized] = await Effect.runPromise(
    context.composition.applicationStorage
      .select({ id: agentRuns.id })
      .from(agentRuns)
      .where(
        and(
          eq(agentRuns.id, runId),
          eq(agentRuns.status, "running"),
          eq(agentRuns.activeAttemptId, authority.attemptId),
          eq(agentRuns.activeAttemptFence, authority.attemptFence),
          eq(agentRuns.controlRevision, authority.controlRevision),
          isNull(agentRuns.cancellationRequestedAt),
          sql`${agentRuns.claimExpiresAt}::timestamptz > clock_timestamp()`
        )
      )
      .limit(1)
  )
  return authorized !== undefined
}

async function wakeSettledConversationRun(context: HttpRouteContext, runId: string): Promise<void> {
  try {
    const activity = await context.composition.runtime.runPromise(
      Effect.flatMap(ToolExecutor, (tools) => tools.mutationActivity(runId))
    )
    if (activity.status === "active") return
    const released = await context.composition.runtime.runPromise(
      Effect.flatMap(ConversationTurnStore, (turns) => turns.releaseSettlingForRun(runId))
    )
    if (released === undefined) return
    await context.composition.runCoordinator.wake({ ownerId: released.ownerId })
  } catch {
    // The released turn remains recoverable after a lost live wake-up.
  }
}

export async function handleInternalAgent(
  context: HttpRouteContext
): Promise<Response | undefined> {
  const agentAttachment = context.url.pathname.match(
    /^\/internal\/agent\/runs\/([^/]+)\/attachments\/([^/]+)$/
  )
  if (context.request.method === "GET" && agentAttachment !== null) {
    const runId = Schema.decodeUnknownSync(Schema.String.check(Schema.isUUID()))(
      decodeURIComponent(agentAttachment[1]!)
    )
    const attachmentId = Schema.decodeUnknownSync(Schema.String.check(Schema.isUUID()))(
      decodeURIComponent(agentAttachment[2]!)
    )
    if (!(await hasAgentRunResourceAuthority(context, runId))) {
      return json({ code: "authority_lost" }, 409)
    }
    const loaded = await context.runTelemetry(
      MessageAttachmentStore.use((store) => store.loadForAgent(runId, attachmentId)).pipe(
        Effect.result
      )
    )
    if (loaded._tag === "Failure") {
      const failure = loaded.failure
      return json({ code: failure.code ?? "storage_failed" }, attachmentFailureStatus(failure))
    }
    const attachment = loaded.success
    return secure(
      new Response(Uint8Array.from(attachment.body).buffer, {
        headers: {
          "content-type": attachment.mediaType,
          "content-length": String(attachment.byteLength),
          "x-bob-content-hash": attachment.contentHash
        }
      })
    )
  }

  if (context.request.method === "POST" && context.url.pathname === "/internal/tools") {
    const command = Schema.decodeUnknownSync(ToolCommand)(await context.readJson())
    const authority = toolAuthority(context.request)
    const suppliedCorrelation = context.request.headers.get("x-bob-correlation-id")
    const correlationId =
      suppliedCorrelation === null
        ? command.runId
        : Schema.decodeUnknownSync(Schema.String.check(Schema.isUUID()))(suppliedCorrelation)
    const startedAt = Date.now()
    let status: "completed" | "failed" = "failed"
    try {
      return json(
        await context.runTelemetry(
          withTraceparent(
            withBobSpan(
              {
                name: "bob.tool.execute",
                correlationId,
                feature: featureForToolName(context.composition.profile, command.name),
                runId: command.runId,
                toolName: command.name
              },
              Effect.gen(function* () {
                const tools = yield* ToolExecutor
                const result = yield* tools.execute(command, authority)
                status = result.ok ? "completed" : "failed"
                yield* recordDecision({
                  name: "bob.decision.policy",
                  code: result.ok ? "allowed" : "confirmation_required",
                  outcome: result.ok ? "allowed" : "denied"
                })
                yield* promiseEffect(async () => {
                  await wakeSettledConversationRun(context, command.runId)
                })
                return result
              })
            ),
            context.request.headers.get("traceparent")
          )
        )
      )
    } finally {
      await context.composition.runtime.runPromise(
        emitHealth({
          type: "tool_call",
          correlationId,
          runId: command.runId,
          toolName: command.name,
          status,
          durationMs: Math.max(0, Date.now() - startedAt)
        })
      )
    }
  }

  if (
    context.request.method === "POST" &&
    context.url.pathname === "/internal/agent/operations/load"
  ) {
    const input = Schema.decodeUnknownSync(AgentRunOperationsLoadRequest)(await context.readJson())
    return json({
      operations: await context.composition.runtime.runPromise(
        Effect.flatMap(AgentRunStore, (runs) => runs.loadOperations(input.runId, input.attemptId))
      )
    })
  }

  if (context.request.method === "POST" && context.url.pathname === "/internal/agent/operations") {
    const input = Schema.decodeUnknownSync(AgentRunOperationAppendRequest)(await context.readJson())
    return json({
      status: await context.composition.runtime.runPromise(
        Effect.flatMap(AgentRunStore, (runs) =>
          runs.appendOperation(input.operation, input.attemptId)
        )
      )
    })
  }

  if (
    context.request.method === "POST" &&
    context.url.pathname === "/internal/agent-runs/acquire"
  ) {
    const input = Schema.decodeUnknownSync(AcquireAgentRun)(await context.readJson())
    return json(
      await context.composition.runtime.runPromise(
        Effect.flatMap(AgentRunGateway, (gateway) => gateway.acquire(input))
      )
    )
  }

  if (context.request.method === "POST" && context.url.pathname === "/internal/agent-runs/renew") {
    const input = Schema.decodeUnknownSync(RenewAgentRunLease)(await context.readJson())
    return json(
      await context.composition.runtime.runPromise(
        Effect.flatMap(AgentRunGateway, (gateway) => gateway.renew(input))
      )
    )
  }

  if (
    context.request.method === "POST" &&
    context.url.pathname === "/internal/agent-runs/control"
  ) {
    const authority = Schema.decodeUnknownSync(AgentRunAttemptAuthority)(await context.readJson())
    return json(
      await context.composition.runtime.runPromise(
        Effect.flatMap(AgentRunGateway, (gateway) => gateway.readControl(authority))
      )
    )
  }

  if (
    context.request.method === "POST" &&
    context.url.pathname === "/internal/agent-runs/checkpoint"
  ) {
    const input = Schema.decodeUnknownSync(AppendAgentRunCheckpoint)(await context.readJson())
    return json({
      status: await context.composition.runtime.runPromise(
        Effect.flatMap(AgentRunGateway, (gateway) => gateway.appendCheckpoint(input))
      )
    })
  }

  if (
    context.request.method === "POST" &&
    context.url.pathname === "/internal/agent-runs/outcome"
  ) {
    const input = Schema.decodeUnknownSync(RecordAgentRunOutcome)(await context.readJson())
    return json({
      status: await context.composition.runtime.runPromise(
        Effect.flatMap(AgentRunGateway, (gateway) => gateway.recordOutcome(input))
      )
    })
  }

  if (context.request.method === "POST" && context.url.pathname === "/internal/agent/result") {
    Schema.decodeUnknownSync(AgentRunResult)(await context.readJson())
    return json({ ok: true })
  }

  return undefined
}
