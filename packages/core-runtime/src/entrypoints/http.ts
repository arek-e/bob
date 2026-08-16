import {
  AgentRunOperationAppendRequest,
  AgentRunOperationsLoadRequest,
  AgentRunResult
} from "@bob/contracts/agent"
import { NormalizedInboundEvent, NormalizedStatusEvent } from "@bob/contracts/channel"
import { DeliveryReconciliationResponse, DeliveryResult } from "@bob/contracts/delivery"
import { OwnerSettingsUpdate } from "@bob/contracts/settings"
import { ToolCommand } from "@bob/contracts/tools"
import { MemoryCandidateCorrection } from "@bob/contracts/ui/core"
import { featureForToolName } from "@bob/observability/attribution"
import { recordDecision, withBobSpan, type BobSpan } from "@bob/observability/effect"
import { observeHealth } from "@bob/observability/events"
import { externalParentFromTraceparent } from "@bob/observability/propagation"
import { sql } from "drizzle-orm"
import { Effect, Schema } from "effect"

import type { CoreBindings } from "../bindings.ts"
import type { CoreComposer, CoreComposition } from "../composition.ts"

import { createOwnerAuth, ownerSession } from "../modules/auth/service.ts"
import { publishDeliveryFollowups } from "../modules/delivery/followups.ts"
import { authorizeCoreRequest, authorizeSetupRequest } from "../modules/policy/access.ts"

async function wakeSettledConversationRun(
  composition: CoreComposition,
  runId: string
): Promise<void> {
  try {
    const activity = await composition.services.tools.mutationActivity(runId)
    if (activity.status === "active") return
    const released = await composition.services.turns.releaseSettlingForRun(runId)
    if (released === undefined) return
    await (composition.runCoordinator ?? composition.ownerRunCoordinator).wake({
      ownerId: released.ownerId
    })
  } catch {
    // The released turn remains recoverable after a lost live wake-up.
  }
}

const MAX_BODY_BYTES = 64 * 1024
const securityHeaders = {
  "cache-control": "no-store",
  "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff"
}

export interface CoreTelemetryRunner {
  readonly runPromise: <A, E>(effect: Effect.Effect<A, E>) => Promise<A>
}

function promiseEffect<A>(operation: (signal: AbortSignal) => Promise<A>) {
  return Effect.tryPromise({ try: operation, catch: (error) => error })
}

function withRequestParent<A, E>(
  request: Request,
  effect: Effect.Effect<A, E>
): Effect.Effect<A, E> {
  const parent = externalParentFromTraceparent(request.headers.get("traceparent"))
  return parent === undefined ? effect : Effect.withParentSpan(effect, parent)
}

function deliveryResultSpan(
  name: "bob.delivery_result.accept" | "bob.delivery_result.record",
  event: typeof NormalizedStatusEvent.Type
): BobSpan {
  const common = { name, correlationId: event.correlationId, feature: "delivery" as const }
  const outboxId = event.outboxId
  const deliveryAttemptId = event.attemptId
  if (outboxId === undefined && deliveryAttemptId === undefined) return common
  if (outboxId === undefined && deliveryAttemptId !== undefined) {
    return { ...common, deliveryAttemptId }
  }
  if (outboxId !== undefined && deliveryAttemptId === undefined) return { ...common, outboxId }
  if (outboxId === undefined || deliveryAttemptId === undefined) return common
  return { ...common, outboxId, deliveryAttemptId }
}

function json<Value>(value: Value, status = 200): Response {
  return Response.json(value, { status, headers: securityHeaders })
}

function secure(response: Response): Response {
  const headers = new Headers(response.headers)
  for (const [name, value] of Object.entries(securityHeaders)) headers.set(name, value)
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  })
}

async function readJson(request: Request): Promise<typeof Schema.Json.Type> {
  const declaredLength = Number(request.headers.get("content-length") ?? "0")
  if (declaredLength > MAX_BODY_BYTES) throw new Error("body_too_large")
  const bytes = new Uint8Array(await request.arrayBuffer())
  if (bytes.byteLength > MAX_BODY_BYTES) throw new Error("body_too_large")
  return Schema.decodeUnknownSync(Schema.Json)(JSON.parse(new TextDecoder().decode(bytes)))
}

function idempotencyKey(request: Request): string {
  const value = request.headers.get("idempotency-key")
  if (value === null || value.length < 8 || value.length > 200) {
    throw new Error("A valid idempotency key is required")
  }
  return value
}

async function authUserExists(bindings: CoreBindings): Promise<boolean> {
  const rows = await bindings.DB.execute<{ id: string }>(sql`SELECT id FROM auth_user LIMIT 1`)
  return rows.length > 0
}

async function handleSetup(
  request: Request,
  bindings: CoreBindings,
  compose: CoreComposer
): Promise<Response> {
  try {
    await authorizeSetupRequest(request, { setupToken: bindings.SETUP_TOKEN })
  } catch {
    return json({ code: "unauthorized" }, 401)
  }

  if (request.method === "GET") {
    return json({ setupRequired: !(await authUserExists(bindings)) })
  }
  if (request.method !== "POST") return json({ code: "method_not_allowed" }, 405)
  if (await authUserExists(bindings)) return json({ code: "setup_complete" }, 409)

  let value: typeof Schema.Json.Type
  try {
    value = await readJson(request)
  } catch {
    return json({ code: "invalid_request" }, 400)
  }
  const passwordResult = Schema.decodeUnknownExit(
    Schema.Struct({
      password: Schema.String.check(Schema.isMinLength(12), Schema.isMaxLength(128))
    })
  )(value)
  if (passwordResult._tag === "Failure") {
    return json({ code: "invalid_password" }, 400)
  }
  const password = passwordResult.value.password
  await compose(bindings).services.ownerDataKeys.ensure(bindings.OWNER_ID)

  const headers = new Headers(request.headers)
  headers.delete("content-length")
  headers.set("content-type", "application/json")
  const signupRequest = new Request(new URL("/api/auth/sign-up/email", request.url), {
    method: "POST",
    headers,
    body: JSON.stringify({
      name: "Owner",
      email: bindings.OWNER_ACCESS_EMAIL,
      password
    })
  })
  return secure(await createOwnerAuth(bindings, { allowSignUp: true }).handler(signupRequest))
}

export async function handleHttp(
  request: Request,
  bindings: CoreBindings,
  telemetry?: CoreTelemetryRunner,
  compose?: CoreComposer
): Promise<Response> {
  const runTelemetry = telemetry?.runPromise ?? Effect.runPromise
  const url = new URL(request.url)
  if (request.method === "GET" && url.pathname === "/health") {
    return json({ healthy: true, service: "core-runtime", version: 1 })
  }

  if (url.pathname === "/api/auth" || url.pathname.startsWith("/api/auth/")) {
    return secure(await createOwnerAuth(bindings).handler(request))
  }

  if (url.pathname === "/setup/api") {
    if (compose === undefined) throw new Error("Core composition is required")
    return handleSetup(request, bindings, compose)
  }

  if (url.pathname.startsWith("/api/")) {
    try {
      if ((await ownerSession(request, bindings)) === null) {
        return json({ code: "unauthorized" }, 401)
      }
    } catch {
      return json({ code: "unauthorized" }, 401)
    }
  } else if (url.pathname.startsWith("/internal/")) {
    try {
      await authorizeCoreRequest(request, {
        ingressSecret: bindings.INGRESS_CALLER_SECRET,
        egressSecret: bindings.EGRESS_CALLER_SECRET,
        agentSecret: bindings.AGENT_CALLER_SECRET
      })
    } catch {
      return json({ code: "unauthorized" }, 401)
    }
  } else {
    if (bindings.ASSETS !== undefined) return bindings.ASSETS.fetch(request)
    return json({ code: "not_found" }, 404)
  }

  try {
    if (compose === undefined) throw new Error("Core composition is required")
    const composition = compose(bindings)
    const jobQueue = () => {
      const jobs = composition.jobQueue ?? composition.jobs
      if (jobs === undefined) throw new Error("Job Queue is required")
      return jobs
    }

    if (request.method === "GET" && url.pathname === "/internal/readiness") {
      const [result] = await bindings.DB.execute<{ ready: number }>(sql`SELECT 1 AS ready`)
      return json({ ready: result?.ready === 1 }, result?.ready === 1 ? 200 : 503)
    }

    if (request.method === "POST" && url.pathname === "/internal/inbound") {
      const event = Schema.decodeUnknownSync(NormalizedInboundEvent)(await readJson(request))
      return json(
        await runTelemetry(
          withRequestParent(
            request,
            withBobSpan(
              {
                name: "bob.inbound.accept",
                correlationId: event.correlationId,
                feature: "assistant"
              },
              withBobSpan(
                {
                  name: "bob.inbound.persist",
                  correlationId: event.correlationId,
                  feature: "assistant"
                },
                promiseEffect(() => composition.services.conversations.acceptInbound(event))
              )
            )
          )
        )
      )
    }

    const inboundEnqueued = url.pathname.match(/^\/internal\/inbound\/([^/]+)\/enqueued$/)
    if (request.method === "POST" && inboundEnqueued !== null) {
      const eventId = decodeURIComponent(inboundEnqueued[1]!)
      const correlationId = request.headers.get("x-bob-correlation-id") ?? eventId
      await runTelemetry(
        withRequestParent(
          request,
          withBobSpan(
            {
              name: "bob.inbound.confirm_accept",
              correlationId,
              feature: "assistant"
            },
            promiseEffect(() =>
              composition.services.conversations.markEnqueued(eventId, new Date().toISOString())
            )
          )
        )
      )
      return json({ ok: true })
    }

    if (request.method === "POST" && url.pathname === "/internal/status") {
      const event = Schema.decodeUnknownSync(NormalizedStatusEvent)(await readJson(request))
      const readyFollowups = await runTelemetry(
        withRequestParent(
          request,
          withBobSpan(
            deliveryResultSpan("bob.delivery_result.accept", event),
            withBobSpan(
              deliveryResultSpan("bob.delivery_result.record", event),
              promiseEffect(() => composition.services.delivery.recordProviderEvent(event))
            )
          )
        )
      )
      await publishDeliveryFollowups(
        jobQueue().outbound,
        composition.services.delivery,
        readyFollowups,
        event.correlationId
      )
      return json({ ok: true })
    }

    const outboxClaim = url.pathname.match(/^\/internal\/outbox\/([^/]+)\/claim$/)
    if (request.method === "POST" && outboxClaim !== null) {
      const outboxId = Schema.decodeUnknownSync(Schema.String.check(Schema.isUUID()))(
        decodeURIComponent(outboxClaim[1]!)
      )
      const suppliedCorrelation = request.headers.get("x-bob-correlation-id")
      const correlationId =
        suppliedCorrelation === null
          ? outboxId
          : Schema.decodeUnknownSync(Schema.String.check(Schema.isUUID()))(suppliedCorrelation)
      const dispatchGeneration = Schema.decodeUnknownSync(
        Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
      )(Number(request.headers.get("x-bob-dispatch-generation") ?? "0"))
      const claim = await runTelemetry(
        withRequestParent(
          request,
          withBobSpan(
            {
              name: "bob.outbox.claim",
              correlationId,
              outboxId,
              feature: "delivery"
            },
            promiseEffect(() =>
              composition.services.delivery.claimOutbox(outboxId, 60_000, dispatchGeneration)
            )
          )
        )
      )
      return claim === undefined
        ? json(
            {
              claim: null,
              disposition: await composition.services.delivery.outboxDisposition(
                outboxId,
                dispatchGeneration
              )
            },
            409
          )
        : json(claim)
    }

    const outboxResult = url.pathname.match(/^\/internal\/outbox\/([^/]+)\/result$/)
    if (request.method === "POST" && outboxResult !== null) {
      const result = Schema.decodeUnknownSync(DeliveryResult)(await readJson(request))
      if (result.outboxId !== decodeURIComponent(outboxResult[1]!))
        return json({ code: "id_mismatch" }, 400)
      const readyFollowups = await runTelemetry(
        withRequestParent(
          request,
          withBobSpan(
            {
              name: "bob.delivery_result.accept",
              correlationId: result.correlationId ?? result.outboxId,
              outboxId: result.outboxId,
              deliveryAttemptId: result.attemptId,
              feature: "delivery"
            },
            withBobSpan(
              {
                name: "bob.delivery_result.record",
                correlationId: result.correlationId ?? result.outboxId,
                outboxId: result.outboxId,
                deliveryAttemptId: result.attemptId,
                feature: "delivery"
              },
              promiseEffect(() => composition.services.delivery.recordResult(result))
            )
          )
        )
      )
      await publishDeliveryFollowups(
        jobQueue().outbound,
        composition.services.delivery,
        readyFollowups,
        result.correlationId ?? result.outboxId
      )
      return json({ ok: true })
    }

    if (request.method === "POST" && url.pathname === "/internal/tools") {
      const command = Schema.decodeUnknownSync(ToolCommand)(await readJson(request))
      const suppliedCorrelation = request.headers.get("x-bob-correlation-id")
      const correlationId =
        suppliedCorrelation === null
          ? command.runId
          : Schema.decodeUnknownSync(Schema.String.check(Schema.isUUID()))(suppliedCorrelation)
      const startedAt = Date.now()
      let status: "completed" | "failed" = "failed"
      try {
        return json(
          await runTelemetry(
            withRequestParent(
              request,
              withBobSpan(
                {
                  name: "bob.tool.execute",
                  correlationId,
                  feature: featureForToolName(composition.profile, command.name),
                  runId: command.runId,
                  toolName: command.name
                },
                Effect.gen(function* () {
                  const result = yield* withBobSpan(
                    {
                      name: "bob.tool.domain",
                      correlationId,
                      feature: featureForToolName(composition.profile, command.name),
                      runId: command.runId,
                      toolName: command.name
                    },
                    promiseEffect(() => composition.services.tools.execute(command))
                  )
                  status = result.ok ? "completed" : "failed"
                  yield* recordDecision({
                    name: "bob.decision.policy",
                    code: result.ok ? "allowed" : "confirmation_required",
                    outcome: result.ok ? "allowed" : "denied"
                  })
                  yield* promiseEffect(async () => {
                    await wakeSettledConversationRun(composition, command.runId)
                  })
                  return result
                })
              )
            )
          )
        )
      } finally {
        await observeHealth(composition.services.events, {
          type: "tool_call",
          correlationId,
          runId: command.runId,
          toolName: command.name,
          status,
          durationMs: Math.max(0, Date.now() - startedAt)
        })
      }
    }

    if (request.method === "POST" && url.pathname === "/internal/agent/operations/load") {
      const input = Schema.decodeUnknownSync(AgentRunOperationsLoadRequest)(await readJson(request))
      return json({
        operations: await composition.services.runs.loadOperations(input.runId, input.attemptId)
      })
    }

    if (request.method === "POST" && url.pathname === "/internal/agent/operations") {
      const input = Schema.decodeUnknownSync(AgentRunOperationAppendRequest)(
        await readJson(request)
      )
      return json({
        status: await composition.services.runs.appendOperation(input.operation, input.attemptId)
      })
    }

    if (request.method === "GET" && url.pathname === "/api/settings") {
      return json({
        settings: await composition.services.settings.get(composition.config.OWNER_ID),
        connections: await composition.services.settings.connections(composition.config.OWNER_ID)
      })
    }

    if (request.method === "PUT" && url.pathname === "/api/settings") {
      const input = Schema.decodeUnknownSync(OwnerSettingsUpdate)(await readJson(request))
      const settings = await composition.services.settings.update(
        composition.config.OWNER_ID,
        input,
        idempotencyKey(request)
      )
      return json({
        settings,
        connections: await composition.services.settings.connections(composition.config.OWNER_ID)
      })
    }

    for (const route of composition.runtime.ownerRoutes) {
      const result = await route.handle({
        request,
        url,
        ownerId: composition.config.OWNER_ID,
        readJson: () => readJson(request),
        idempotencyKey: () => idempotencyKey(request)
      })
      if (result !== undefined) return json(result.body, result.status)
    }

    if (request.method === "GET" && url.pathname === "/api/alerts") {
      return json({
        alerts: await composition.services.alerts.list(composition.config.OWNER_ID)
      })
    }

    const alertReconcile = url.pathname.match(/^\/api\/alerts\/([^/]+)\/reconcile$/)
    if (request.method === "POST" && alertReconcile !== null) {
      idempotencyKey(request)
      const alertId = decodeURIComponent(alertReconcile[1]!)
      const alert = await composition.services.alerts.get(composition.config.OWNER_ID, alertId)
      if (alert === undefined) return json({ code: "not_found" }, 404)
      await composition.services.alerts.setState(
        composition.config.OWNER_ID,
        alert.id,
        "reconciling"
      )
      if (alert.code === "inbound_exhausted") {
        const decision = await composition.services.conversations.prepareInboundRecovery(
          alert.objectId,
          4
        )
        if (decision === "recover") {
          await jobQueue().inbound.publish({ eventId: alert.objectId })
          await composition.services.conversations.markEnqueued(
            alert.objectId,
            new Date().toISOString()
          )
          await composition.services.alerts.setState(
            composition.config.OWNER_ID,
            alert.id,
            "resolved"
          )
        }
        return json({ status: decision })
      }
      if (alert.code === "outbound_exhausted") {
        const decision = await composition.services.delivery.prepareOutboundRecovery(
          alert.objectId,
          4
        )
        if (decision.status === "recover") {
          await jobQueue().outbound.publish({
            outboxId: alert.objectId,
            dispatchGeneration: decision.dispatchGeneration
          })
          await composition.services.delivery.markEnqueued(
            alert.objectId,
            new Date().toISOString(),
            decision.dispatchGeneration
          )
          await composition.services.alerts.setState(
            composition.config.OWNER_ID,
            alert.id,
            "resolved"
          )
        } else if (decision.status === "resolved") {
          await composition.services.alerts.setState(
            composition.config.OWNER_ID,
            alert.id,
            "resolved"
          )
        }
        return json({ status: decision.status })
      }
      if (alert.code === "delivery_uncertain" || alert.code === "delivery_result_exhausted") {
        let status = await composition.services.delivery.reconcileOutbox(alert.objectId)
        if (status === "pending") {
          const target = await composition.services.delivery.reconciliationTarget(alert.objectId)
          if (target !== undefined) {
            const response = await fetch(
              `${composition.config.CHANNEL_EGRESS_URL}/internal/delivery-reconciliation`,
              {
                method: "POST",
                headers: {
                  "content-type": "application/json",
                  "x-bob-caller-token": composition.config.EGRESS_CALLER_SECRET
                },
                body: JSON.stringify(target),
                signal: AbortSignal.timeout(10_000)
              }
            )
            if (response.ok) {
              const provider = Schema.decodeUnknownSync(DeliveryReconciliationResponse)(
                await response.json()
              )
              if (provider.status === "resolved") {
                await composition.services.delivery.recordResult(provider.result)
                status = await composition.services.delivery.reconcileOutbox(alert.objectId)
              }
            }
          }
        }
        if (status === "resolved") {
          await composition.services.alerts.setState(
            composition.config.OWNER_ID,
            alert.id,
            "resolved"
          )
        }
        return json({ status })
      }
      if (alert.code === "agent_authentication_failed") {
        const response = await fetch(`${composition.config.AGENT_ADMIN_URL}/v1/admin/auth/status`, {
          headers: {
            "x-bob-caller-token": composition.config.AGENT_CALLER_SECRET
          }
        })
        const status = Schema.decodeUnknownSync(
          Schema.Struct({ configured: Schema.optionalKey(Schema.Boolean) })
        )(await response.json())
        if (response.ok && status.configured === true) {
          await composition.services.alerts.setState(
            composition.config.OWNER_ID,
            alert.id,
            "resolved"
          )
        }
        return json({ status: status.configured === true ? "resolved" : "pending" })
      }
      await composition.services.alerts.setState(composition.config.OWNER_ID, alert.id, "resolved")
      return json({ status: "manual_action_required" })
    }

    if (request.method === "GET" && url.pathname === "/api/memory/candidates") {
      return json({
        candidates: await composition.services.memory.listCandidates(composition.config.OWNER_ID)
      })
    }

    const memoryConfirm = url.pathname.match(/^\/api\/memory\/candidates\/([^/]+)\/confirm$/)
    if (request.method === "POST" && memoryConfirm !== null) {
      const revisionId = await composition.services.memory.confirm(
        composition.config.OWNER_ID,
        decodeURIComponent(memoryConfirm[1]!),
        "owner_ui",
        idempotencyKey(request)
      )
      return json({ revisionId })
    }

    const memoryCorrect = url.pathname.match(/^\/api\/memory\/candidates\/([^/]+)\/correct$/)
    if (request.method === "POST" && memoryCorrect !== null) {
      const input = Schema.decodeUnknownSync(MemoryCandidateCorrection)(await readJson(request))
      const candidateId = await composition.services.memory.correct(
        composition.config.OWNER_ID,
        decodeURIComponent(memoryCorrect[1]!),
        input.canonicalText,
        idempotencyKey(request)
      )
      return json({ candidateId })
    }

    const memoryReject = url.pathname.match(/^\/api\/memory\/candidates\/([^/]+)\/reject$/)
    if (request.method === "POST" && memoryReject !== null) {
      await composition.services.memory.reject(
        composition.config.OWNER_ID,
        decodeURIComponent(memoryReject[1]!),
        idempotencyKey(request)
      )
      return json({ ok: true })
    }

    if (request.method === "GET" && url.pathname === "/api/agent/status") {
      const response = await fetch(`${composition.config.AGENT_ADMIN_URL}/v1/admin/auth/status`, {
        headers: {
          "x-bob-caller-token": composition.config.AGENT_CALLER_SECRET
        }
      })
      return json(await response.json(), response.status)
    }

    if (request.method === "POST" && url.pathname === "/api/agent/device-login") {
      const response = await fetch(
        `${composition.config.AGENT_ADMIN_URL}/v1/admin/auth/device-login`,
        {
          method: "POST",
          headers: {
            "x-bob-caller-token": composition.config.AGENT_CALLER_SECRET
          }
        }
      )
      return json(await response.json(), response.status)
    }

    if (request.method === "POST" && url.pathname === "/internal/agent/result") {
      Schema.decodeUnknownSync(AgentRunResult)(await readJson(request))
      return json({ ok: true })
    }
    return json({ code: "not_found" }, 404)
  } catch (error) {
    const status = error instanceof Error && error.message === "body_too_large" ? 413 : 400
    return json({ code: status === 413 ? "body_too_large" : "invalid_request" }, status)
  }
}
