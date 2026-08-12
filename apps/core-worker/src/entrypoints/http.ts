import { AgentRunResult } from "@bob/contracts/agent"
import { NormalizedInboundEvent, NormalizedStatusEvent } from "@bob/contracts/channel"
import { DeliveryResult } from "@bob/contracts/delivery"
import { ConnectionProvider, OwnerSettingsUpdate } from "@bob/contracts/settings"
import { ToolCommand } from "@bob/contracts/tools"
import {
  JournalEntryCreate,
  JournalEntryUpdate,
  MemoryCandidateCorrection,
  ReminderSnoozeRequest,
  TrainingProposalApproval
} from "@bob/contracts/ui"
import { featureForToolName } from "@bob/observability/attribution"
import { recordDecision, withBobSpan } from "@bob/observability/effect"
import { externalParentFromTraceparent } from "@bob/observability/propagation"
import { Effect, Schema } from "effect"

import type { CoreBindings } from "../bindings.ts"

import { composeCore } from "../composition.ts"
import { createOwnerAuth, ownerSession } from "../modules/auth/service.ts"
import {
  authorizeCoreRequest,
  authorizeSetupRequest,
  type AccessTokenVerifier
} from "../modules/policy/access.ts"

async function wakeSettledConversationRun(
  bindings: CoreBindings,
  composition: ReturnType<typeof composeCore>,
  runId: string
): Promise<void> {
  try {
    const activity = await composition.services.tools.mutationActivity(runId)
    if (activity.status === "active") return
    const released = await composition.services.turns.releaseSettlingForRun(runId)
    if (released === undefined) return
    const coordinators = bindings.OWNER_RUN_COORDINATOR.jurisdiction("eu")
    await coordinators
      .get(coordinators.idFromName(released.ownerId))
      .fetch("https://coordinator.internal/wake", { method: "POST" })
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

function json(value: unknown, status = 200): Response {
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

async function readJson(request: Request): Promise<unknown> {
  const declaredLength = Number(request.headers.get("content-length") ?? "0")
  if (declaredLength > MAX_BODY_BYTES) throw new Error("body_too_large")
  const bytes = new Uint8Array(await request.arrayBuffer())
  if (bytes.byteLength > MAX_BODY_BYTES) throw new Error("body_too_large")
  return JSON.parse(new TextDecoder().decode(bytes)) as unknown
}

function idempotencyKey(request: Request): string {
  const value = request.headers.get("idempotency-key")
  if (value === null || value.length < 8 || value.length > 200) {
    throw new Error("A valid idempotency key is required")
  }
  return value
}

async function authUserExists(bindings: CoreBindings): Promise<boolean> {
  const row = await bindings.DB.prepare("SELECT `id` FROM `auth_user` LIMIT 1").first()
  return row !== null
}

async function handleSetup(
  request: Request,
  bindings: CoreBindings,
  verifyAccess?: AccessTokenVerifier
): Promise<Response> {
  try {
    await authorizeSetupRequest(
      request,
      {
        ownerEmail: bindings.OWNER_ACCESS_EMAIL,
        accessIssuer: `https://${bindings.ACCESS_TEAM_DOMAIN}`,
        accessAudience: bindings.SETUP_ACCESS_AUDIENCE
      },
      verifyAccess
    )
  } catch {
    return json({ code: "unauthorized" }, 401)
  }

  if (request.method === "GET") {
    return json({ setupRequired: !(await authUserExists(bindings)) })
  }
  if (request.method !== "POST") return json({ code: "method_not_allowed" }, 405)
  if (await authUserExists(bindings)) return json({ code: "setup_complete" }, 409)

  let value: unknown
  try {
    value = await readJson(request)
  } catch {
    return json({ code: "invalid_request" }, 400)
  }
  const password =
    typeof value === "object" && value !== null && "password" in value
      ? (value as { password?: unknown }).password
      : undefined
  if (typeof password !== "string" || password.length < 12 || password.length > 128) {
    return json({ code: "invalid_password" }, 400)
  }

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
  verifyAccess?: AccessTokenVerifier,
  telemetry?: CoreTelemetryRunner
): Promise<Response> {
  const runTelemetry = telemetry?.runPromise ?? Effect.runPromise
  const url = new URL(request.url)
  if (request.method === "GET" && url.pathname === "/health") {
    return json({ healthy: true, service: "core", version: 1 })
  }

  if (url.pathname === "/api/auth" || url.pathname.startsWith("/api/auth/")) {
    return secure(await createOwnerAuth(bindings).handler(request))
  }

  if (url.pathname === "/setup/api") {
    return handleSetup(request, bindings, verifyAccess)
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
      await authorizeCoreRequest(
        request,
        {
          ingressSecret: bindings.INGRESS_CALLER_SECRET,
          egressSecret: bindings.EGRESS_CALLER_SECRET,
          agentSubject: bindings.AGENT_CALLER_SUBJECT,
          accessIssuer: `https://${bindings.ACCESS_TEAM_DOMAIN}`,
          accessAudience: bindings.CORE_ACCESS_AUDIENCE
        },
        verifyAccess
      )
    } catch {
      return json({ code: "unauthorized" }, 401)
    }
  } else {
    return json({ code: "not_found" }, 404)
  }

  try {
    const composition = composeCore(bindings)

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
      await runTelemetry(
        withRequestParent(
          request,
          withBobSpan(
            {
              name: "bob.delivery_result.accept",
              correlationId: event.correlationId,
              feature: "delivery",
              ...(event.outboxId === undefined ? {} : { outboxId: event.outboxId }),
              ...(event.attemptId === undefined ? {} : { deliveryAttemptId: event.attemptId })
            },
            withBobSpan(
              {
                name: "bob.delivery_result.record",
                correlationId: event.correlationId,
                feature: "delivery",
                ...(event.outboxId === undefined ? {} : { outboxId: event.outboxId }),
                ...(event.attemptId === undefined ? {} : { deliveryAttemptId: event.attemptId })
              },
              promiseEffect(() => composition.services.delivery.recordProviderEvent(event))
            )
          )
        )
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
            promiseEffect(() => composition.services.delivery.claimOutbox(outboxId, 60_000))
          )
        )
      )
      return claim === undefined
        ? json(
            {
              claim: null,
              disposition: await composition.services.delivery.outboxDisposition(outboxId)
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
      await runTelemetry(
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
                  feature: featureForToolName(command.name),
                  runId: command.runId,
                  toolName: command.name
                },
                Effect.gen(function* () {
                  const result = yield* withBobSpan(
                    {
                      name: "bob.tool.domain",
                      correlationId,
                      feature: featureForToolName(command.name),
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
                    await wakeSettledConversationRun(bindings, composition, command.runId)
                  })
                  return result
                })
              )
            )
          )
        )
      } finally {
        try {
          await composition.services.events.emit({
            type: "tool_call",
            correlationId,
            runId: command.runId,
            toolName: command.name,
            status,
            durationMs: Math.max(0, Date.now() - startedAt)
          })
        } catch {
          // Telemetry must not change a tool result.
        }
      }
    }

    if (request.method === "GET" && url.pathname === "/api/settings") {
      return json({
        settings: await composition.services.settings.get(composition.config.OWNER_ID),
        connections: [
          ...(await composition.services.settings.connections(composition.config.OWNER_ID)),
          ...(await composition.services.connections.list(composition.config.OWNER_ID))
        ]
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
        connections: [
          ...(await composition.services.settings.connections(composition.config.OWNER_ID)),
          ...(await composition.services.connections.list(composition.config.OWNER_ID))
        ]
      })
    }

    const connectionSession = url.pathname.match(/^\/api\/connections\/([^/]+)\/session$/)
    if (request.method === "POST" && connectionSession !== null) {
      const provider = Schema.decodeUnknownSync(ConnectionProvider)(
        decodeURIComponent(connectionSession[1]!)
      )
      return json(
        await composition.services.connections.createSession(composition.config.OWNER_ID, provider),
        201
      )
    }

    if (request.method === "GET" && url.pathname === "/api/reminders") {
      return json({
        reminders: await composition.services.reminders.list(composition.config.OWNER_ID)
      })
    }

    const reminderOccurrenceAction = url.pathname.match(
      /^\/api\/reminder-occurrences\/([^/]+)\/(seen|done|snooze)$/
    )
    if (request.method === "POST" && reminderOccurrenceAction !== null) {
      const occurrenceId = decodeURIComponent(reminderOccurrenceAction[1]!)
      const action = reminderOccurrenceAction[2]!
      const actionKey = idempotencyKey(request)
      if (action === "seen") {
        await composition.services.reminders.acknowledge(
          composition.config.OWNER_ID,
          occurrenceId,
          actionKey
        )
        return json({ ok: true })
      }
      if (action === "done") {
        await composition.services.reminders.complete(
          composition.config.OWNER_ID,
          occurrenceId,
          actionKey
        )
        return json({ ok: true })
      }
      const input = Schema.decodeUnknownSync(ReminderSnoozeRequest)(await readJson(request))
      if (Date.parse(input.dueAt) <= Date.now())
        throw new Error("Snooze time must be in the future")
      const successorOccurrenceId = await composition.services.reminders.snooze(
        composition.config.OWNER_ID,
        occurrenceId,
        input.dueAt,
        actionKey
      )
      return json({ successorOccurrenceId })
    }

    const reminderCancel = url.pathname.match(/^\/api\/reminders\/([^/]+)\/cancel$/)
    if (request.method === "POST" && reminderCancel !== null) {
      await composition.services.reminders.cancel(
        composition.config.OWNER_ID,
        decodeURIComponent(reminderCancel[1]!),
        undefined,
        idempotencyKey(request)
      )
      return json({ ok: true })
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
          await bindings.INBOUND_QUEUE.send({ eventId: alert.objectId })
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
      if (alert.code === "delivery_uncertain" || alert.code === "delivery_result_exhausted") {
        const status = await composition.services.delivery.reconcileOutbox(alert.objectId)
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
            "CF-Access-Client-Id": composition.config.AGENT_ADMIN_ACCESS_CLIENT_ID,
            "CF-Access-Client-Secret": composition.config.AGENT_ADMIN_ACCESS_CLIENT_SECRET
          }
        })
        const status = (await response.json()) as { configured?: boolean }
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

    if (request.method === "POST" && url.pathname === "/api/journal/handoffs") {
      const handoff = await composition.services.journal.createHandoff(
        composition.config.OWNER_ID,
        10 * 60_000,
        idempotencyKey(request)
      )
      return json({
        id: handoff.id,
        expiresAt: handoff.expiresAt,
        path: `/journal/${handoff.id}`,
        bearerToken: false
      })
    }

    if (request.method === "POST" && url.pathname === "/api/journal") {
      const input = Schema.decodeUnknownSync(JournalEntryCreate)(await readJson(request))
      const id = await composition.services.journal.createEntry(
        {
          ownerId: composition.config.OWNER_ID,
          handoffId: input.handoffId,
          text: input.text,
          tags: input.tags,
          ...(input.approvedSummary === undefined ? {} : { approvedSummary: input.approvedSummary })
        },
        idempotencyKey(request)
      )
      return json({ id }, 201)
    }

    if (request.method === "GET" && url.pathname === "/api/journal") {
      const tag = url.searchParams.get("tag") ?? undefined
      return json({
        entries: await composition.services.journal.searchMetadata(composition.config.OWNER_ID, tag)
      })
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

    if (request.method === "GET" && url.pathname === "/api/training/overview") {
      return json(
        await composition.services.training.overview(
          composition.config.OWNER_ID,
          url.searchParams.get("q") ?? undefined
        )
      )
    }

    if (request.method === "GET" && url.pathname === "/api/training/proposals") {
      return json({
        proposals: await composition.services.training.listTrainingProposals(
          composition.config.OWNER_ID
        )
      })
    }

    const trainingApprove = url.pathname.match(/^\/api\/training\/proposals\/([^/]+)\/approve$/)
    if (request.method === "POST" && trainingApprove !== null) {
      const input = Schema.decodeUnknownSync(TrainingProposalApproval)(await readJson(request))
      return json(
        await composition.services.training.approveTrainingProposal(
          composition.config.OWNER_ID,
          decodeURIComponent(trainingApprove[1]!),
          input.proposalHash,
          idempotencyKey(request)
        )
      )
    }

    const journalEntry = url.pathname.match(/^\/api\/journal\/([^/]+)$/)
    if (request.method === "GET" && journalEntry !== null) {
      const entry = await composition.services.journal.readEntry(
        composition.config.OWNER_ID,
        decodeURIComponent(journalEntry[1]!)
      )
      return entry === undefined ? json({ code: "not_found" }, 404) : json(entry)
    }

    if (request.method === "PUT" && journalEntry !== null) {
      const input = Schema.decodeUnknownSync(JournalEntryUpdate)(await readJson(request))
      await composition.services.journal.updateEntry(
        composition.config.OWNER_ID,
        decodeURIComponent(journalEntry[1]!),
        input,
        idempotencyKey(request)
      )
      return json({ ok: true })
    }

    const journalDelete = journalEntry
    if (request.method === "DELETE" && journalDelete !== null) {
      await composition.services.journal.deleteEntry(
        composition.config.OWNER_ID,
        decodeURIComponent(journalDelete[1]!),
        idempotencyKey(request)
      )
      return json({ ok: true })
    }

    if (request.method === "GET" && url.pathname === "/api/agent/status") {
      const response = await fetch(`${composition.config.AGENT_ADMIN_URL}/v1/admin/auth/status`, {
        headers: {
          "CF-Access-Client-Id": composition.config.AGENT_ADMIN_ACCESS_CLIENT_ID,
          "CF-Access-Client-Secret": composition.config.AGENT_ADMIN_ACCESS_CLIENT_SECRET
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
            "CF-Access-Client-Id": composition.config.AGENT_ADMIN_ACCESS_CLIENT_ID,
            "CF-Access-Client-Secret": composition.config.AGENT_ADMIN_ACCESS_CLIENT_SECRET
          }
        }
      )
      return json(await response.json(), response.status)
    }

    if (request.method === "POST" && url.pathname === "/internal/agent/result") {
      Schema.decodeUnknownSync(AgentRunResult)(await readJson(request))
      return json({ ok: true })
    }
    if (bindings.ASSETS !== undefined && !url.pathname.startsWith("/internal/")) {
      return bindings.ASSETS.fetch(request)
    }
    return json({ code: "not_found" }, 404)
  } catch (error) {
    const status = error instanceof Error && error.message === "body_too_large" ? 413 : 400
    return json({ code: status === 413 ? "body_too_large" : "invalid_request" }, status)
  }
}
