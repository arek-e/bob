import type { CoreBindings } from "@bob/core-types/bindings"

import {
  AcquireAgentRun,
  AgentRunAttemptAuthority,
  AgentRunAuthorityLost,
  AgentRunCheckpointConflict,
  AgentRunGateway,
  AgentRunGatewayUnavailable,
  AppendAgentRunCheckpoint,
  RecordAgentRunOutcome,
  RenewAgentRunLease
} from "@bob/agent-runs-types/worker-gateway"
import {
  AgentRunOperationAppendRequest,
  AgentRunOperationsLoadRequest,
  AgentRunResult
} from "@bob/agent-types/run"
import {
  ImageMediaType,
  MessageAttachmentReference,
  MessageAttachmentStore,
  type MessageAttachmentError
} from "@bob/conversations-types/attachment-store"
import { NormalizedInboundEvent, NormalizedStatusEvent } from "@bob/conversations-types/channel"
import { AgentRunStore } from "@bob/conversations-types/run-store"
import { ConversationStore } from "@bob/conversations-types/store"
import { ToolExecutor } from "@bob/conversations-types/tool-executor"
import { ConversationTurnStore } from "@bob/conversations-types/turn-store"
import { agentRuns } from "@bob/db-service/schema/conversations"
import { publishDeliveryFollowups } from "@bob/delivery-service/followups"
import { DeliveryReconciliationResponse, DeliveryResult } from "@bob/delivery-types/delivery"
import { DeliveryStore } from "@bob/delivery-types/store"
import { MemoryStore } from "@bob/memory-types/store"
import {
  featureForToolName,
  elapsedMilliseconds,
  recordDecision,
  withBobSpan,
  type BobSpan,
  emitHealth,
  withTraceparent
} from "@bob/observability"
import { AlertStore } from "@bob/operations-types/alerts"
import { MemoryCandidateCorrection } from "@bob/operations-types/ui"
import {
  authorizeCoreRequest,
  authorizeOwnerEnrollmentRequest,
  authorizeSetupRequest
} from "@bob/policy-service/access"
import { createOwnerAuth, ownerSession } from "@bob/policy-service/auth/service"
import { OwnerDataKeyStore } from "@bob/policy-types/owner-data-key"
import { OwnerSettingsUpdate } from "@bob/settings-types/settings"
import { OwnerSettingsStore } from "@bob/settings-types/store"
import { ToolCommand } from "@bob/tools-types/tools"
import { and, eq, isNull, sql } from "drizzle-orm"
import { Data, Effect, Schema } from "effect"

import type { CoreComposer, CoreComposition, CoreRuntimeRequirements } from "../composition.ts"

class RequestBodyTooLargeError extends Data.TaggedError("RequestBodyTooLargeError") {
  override get message(): string {
    return "body_too_large"
  }
}

async function wakeSettledConversationRun(
  composition: CoreComposition,
  runId: string
): Promise<void> {
  try {
    const activity = await composition.runtime.runPromise(
      Effect.flatMap(ToolExecutor, (tools) => tools.mutationActivity(runId))
    )
    if (activity.status === "active") return
    const released = await composition.runtime.runPromise(
      Effect.flatMap(ConversationTurnStore, (turns) => turns.releaseSettlingForRun(runId))
    )
    if (released === undefined) return
    await composition.runCoordinator.wake({
      ownerId: released.ownerId
    })
  } catch {
    // The released turn remains recoverable after a lost live wake-up.
  }
}

const MAX_BODY_BYTES = 64 * 1024
const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024
const securityHeaders = {
  "cache-control": "no-store",
  "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff"
}

function promiseEffect<A>(operation: (signal: AbortSignal) => Promise<A>) {
  return Effect.tryPromise({ try: operation, catch: (error) => error })
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
  composition: CoreComposition,
  request: Request,
  runId: string
): Promise<boolean> {
  const authority = toolAuthority(request)
  if (authority === undefined && composition.config?.ASYNC_AGENT_RUNS !== "true") return true
  const [run] = await Effect.runPromise(
    composition.applicationStorage
      .select({ executionPoolId: agentRuns.executionPoolId })
      .from(agentRuns)
      .where(eq(agentRuns.id, runId))
      .limit(1)
  )
  if (run?.executionPoolId === null) return true
  if (authority === undefined || authority.runId !== runId) return false
  const [authorized] = await Effect.runPromise(
    composition.applicationStorage
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

async function readJson(request: Request): Promise<typeof Schema.Json.Type> {
  const declaredLength = Number(request.headers.get("content-length") ?? "0")
  if (declaredLength > MAX_BODY_BYTES) throw new RequestBodyTooLargeError()
  const bytes = new Uint8Array(await request.arrayBuffer())
  if (bytes.byteLength > MAX_BODY_BYTES) throw new RequestBodyTooLargeError()
  return Schema.decodeUnknownSync(Schema.Json)(JSON.parse(new TextDecoder().decode(bytes)))
}

async function readAttachmentBytes(request: Request): Promise<Uint8Array> {
  const declaredLength = Number(request.headers.get("content-length") ?? "0")
  if (declaredLength > MAX_ATTACHMENT_BYTES) throw new Error("body_too_large")
  const bytes = new Uint8Array(await request.arrayBuffer())
  if (bytes.byteLength > MAX_ATTACHMENT_BYTES) throw new Error("body_too_large")
  return bytes
}

function attachmentFailureStatus(error: MessageAttachmentError): number {
  if (error.code === "too_large") return 413
  if (error.code === "invalid_media") return 415
  if (
    error.code === "event_missing" ||
    error.code === "attachment_missing" ||
    error.code === "object_missing"
  ) {
    return 404
  }
  return 503
}

function idempotencyKey(request: Request): string {
  const value = request.headers.get("idempotency-key")
  if (value === null || value.length < 8 || value.length > 200) {
    throw new Error("A valid idempotency key is required")
  }
  return value
}

async function authUserExists(bindings: CoreBindings): Promise<boolean> {
  const rows = await Effect.runPromise(
    bindings.DB.execute<{ id: string }>(sql`SELECT id FROM auth_user LIMIT 1`, "objects")
  )
  return rows.length > 0
}

async function handleSetup(
  request: Request,
  bindings: CoreBindings,
  compose: CoreComposer
): Promise<Response> {
  const ownerId = bindings.OWNER_ID
  const ownerEmail = bindings.OWNER_ACCESS_EMAIL
  if (ownerId === undefined || ownerEmail === undefined) {
    return json({ code: "legacy_setup_disabled" }, 404)
  }
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
  const composition = compose(bindings)
  await composition.runtime.runPromise(
    Effect.flatMap(OwnerDataKeyStore, (ownerDataKeys) => ownerDataKeys.ensure(ownerId))
  )

  const headers = new Headers(request.headers)
  headers.delete("content-length")
  headers.set("content-type", "application/json")
  const signupRequest = new Request(new URL("/api/auth/sign-up/email", request.url), {
    method: "POST",
    headers,
    body: JSON.stringify({
      name: "Owner",
      email: ownerEmail,
      password
    })
  })
  return secure(
    await createOwnerAuth(bindings, {
      allowSignUp: true,
      allowedEmail: ownerEmail,
      ownerId
    }).handler(signupRequest)
  )
}

export async function handleHttp(
  request: Request,
  bindings: CoreBindings,
  compose?: CoreComposer
): Promise<Response> {
  const url = new URL(request.url)
  let authenticatedOwnerId: string | undefined
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

  if (url.pathname === "/internal/owners/enroll") {
    if (request.method !== "POST") return json({ code: "method_not_allowed" }, 405)
    try {
      await authorizeOwnerEnrollmentRequest(request, {
        ownerEnrollmentSecret: bindings.OWNER_ENROLLMENT_SECRET
      })
    } catch {
      return json({ code: "unauthorized" }, 401)
    }
    if (compose === undefined) throw new Error("Core composition is required")
    const input = Schema.decodeUnknownSync(
      Schema.Struct({
        ownerId: Schema.String.check(Schema.isUUID()),
        email: Schema.String.check(Schema.isMinLength(3), Schema.isMaxLength(320)),
        password: Schema.String.check(Schema.isMinLength(12), Schema.isMaxLength(128)),
        channel: Schema.Struct({
          accountId: Schema.String.check(Schema.isMinLength(1)),
          lineId: Schema.String.check(Schema.isMinLength(1)),
          senderE164: Schema.String.check(Schema.isPattern(/^\+[1-9]\d{7,14}$/)),
          destinationE164: Schema.String.check(Schema.isPattern(/^\+[1-9]\d{7,14}$/))
        })
      })
    )(await readJson(request))
    const normalizedEmail = input.email.trim().toLowerCase()
    const existingOwners = await Effect.runPromise(
      bindings.DB.execute<{ id: string; email: string }>(
        sql`SELECT id, email FROM auth_user WHERE id = ${input.ownerId} OR lower(email) = ${normalizedEmail}`,
        "objects"
      )
    )
    let conflict: { readonly id: string; readonly email: string } | undefined
    for (const owner of existingOwners) {
      if (owner.id !== input.ownerId || owner.email.trim().toLowerCase() !== normalizedEmail) {
        conflict = owner
        break
      }
    }
    if (conflict !== undefined) return json({ code: "owner_identity_conflict" }, 409)
    if (existingOwners.length === 0) {
      const headers = new Headers(request.headers)
      headers.delete("content-length")
      headers.set("content-type", "application/json")
      const response = await createOwnerAuth(bindings, {
        allowSignUp: true,
        allowedEmail: normalizedEmail,
        ownerId: input.ownerId
      }).handler(
        new Request(new URL("/api/auth/sign-up/email", request.url), {
          method: "POST",
          headers,
          body: JSON.stringify({ name: "Owner", email: normalizedEmail, password: input.password })
        })
      )
      if (!response.ok) return secure(response)
    }
    const composition = compose(bindings)
    await composition.runtime.runPromise(
      Effect.flatMap(OwnerDataKeyStore, (ownerDataKeys) => ownerDataKeys.ensure(input.ownerId))
    )
    await composition.runtime.runPromise(
      Effect.flatMap(ConversationStore, (conversations) =>
        conversations.bindChannel({ ownerId: input.ownerId, ...input.channel })
      )
    )
    return json({ ownerId: input.ownerId, state: "active" }, 201)
  }

  if (url.pathname.startsWith("/api/")) {
    try {
      const session = await ownerSession(request, bindings)
      if (session === null) {
        return json({ code: "unauthorized" }, 401)
      }
      authenticatedOwnerId = session.user.id
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
    const runTelemetry = <A, E, R extends CoreRuntimeRequirements>(
      effect: Effect.Effect<A, E, R>
    ) => composition.runtime.runPromise(effect)
    const jobQueue = () => {
      const jobs = composition.jobQueue
      if (jobs === undefined) throw new Error("Job Queue is required")
      return jobs
    }

    if (request.method === "GET" && url.pathname === "/internal/readiness") {
      const [result] = await Effect.runPromise(
        bindings.DB.execute<{ ready: number }>(sql`SELECT 1 AS ready`, "objects")
      )
      return json({ ready: result?.ready === 1 }, result?.ready === 1 ? 200 : 503)
    }

    if (request.method === "POST" && url.pathname === "/internal/inbound") {
      const event = Schema.decodeUnknownSync(NormalizedInboundEvent)(await readJson(request))
      const ownerId = await runTelemetry(
        Effect.flatMap(ConversationStore, (conversations) => conversations.resolveOwner(event))
      )
      if (ownerId === undefined) return json({ code: "channel_not_bound" }, 403)
      return json(
        await runTelemetry(
          withTraceparent(
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
                Effect.flatMap(ConversationStore, (conversations) =>
                  conversations.acceptInbound(event, ownerId)
                )
              )
            ),
            request.headers.get("traceparent")
          )
        )
      )
    }

    const inboundAttachment = url.pathname.match(
      /^\/internal\/inbound\/([^/]+)\/attachments\/(\d+)$/
    )
    if (request.method === "PUT" && inboundAttachment !== null) {
      const eventId = Schema.decodeUnknownSync(Schema.String.check(Schema.isUUID()))(
        decodeURIComponent(inboundAttachment[1]!)
      )
      const ordinal = Schema.decodeUnknownSync(
        Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 0 }))
      )(Number(inboundAttachment[2]))
      const decodedMediaType = Schema.decodeUnknownExit(ImageMediaType)(
        request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase()
      )
      if (decodedMediaType._tag === "Failure") return json({ code: "invalid_media" }, 415)
      const mediaType = decodedMediaType.value
      const body = await readAttachmentBytes(request)
      const stored = await runTelemetry(
        MessageAttachmentStore.use((store) =>
          store.storeInbound(eventId, ordinal, mediaType, body)
        ).pipe(Effect.result)
      )
      if (stored._tag === "Failure") {
        const failure = stored.failure
        return json({ code: failure.code ?? "storage_failed" }, attachmentFailureStatus(failure))
      }
      return json(Schema.encodeSync(MessageAttachmentReference)(stored.success), 201)
    }

    const agentAttachment = url.pathname.match(
      /^\/internal\/agent\/runs\/([^/]+)\/attachments\/([^/]+)$/
    )
    if (request.method === "GET" && agentAttachment !== null) {
      const runId = Schema.decodeUnknownSync(Schema.String.check(Schema.isUUID()))(
        decodeURIComponent(agentAttachment[1]!)
      )
      const attachmentId = Schema.decodeUnknownSync(Schema.String.check(Schema.isUUID()))(
        decodeURIComponent(agentAttachment[2]!)
      )
      if (!(await hasAgentRunResourceAuthority(composition, request, runId)))
        return json({ code: "authority_lost" }, 409)
      const loaded = await runTelemetry(
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

    const inboundEnqueued = url.pathname.match(/^\/internal\/inbound\/([^/]+)\/enqueued$/)
    if (request.method === "POST" && inboundEnqueued !== null) {
      const eventId = decodeURIComponent(inboundEnqueued[1]!)
      const correlationId = request.headers.get("x-bob-correlation-id") ?? eventId
      await runTelemetry(
        withTraceparent(
          withBobSpan(
            {
              name: "bob.inbound.confirm_accept",
              correlationId,
              feature: "assistant"
            },
            Effect.flatMap(ConversationStore, (conversations) =>
              conversations.markEnqueued(eventId, new Date().toISOString())
            )
          ),
          request.headers.get("traceparent")
        )
      )
      return json({ ok: true })
    }

    if (request.method === "POST" && url.pathname === "/internal/status") {
      const event = Schema.decodeUnknownSync(NormalizedStatusEvent)(await readJson(request))
      let providerAcceptedToDeliveredMs: number | undefined
      if (
        event.status === "delivered" &&
        event.outboxId !== undefined &&
        event.attemptId !== undefined
      ) {
        try {
          const timing = await composition.runtime.runPromise(
            Effect.flatMap(DeliveryStore, (delivery) =>
              delivery.attemptTiming(event.outboxId!, event.attemptId!)
            )
          )
          if (timing?.state === "accepted") {
            providerAcceptedToDeliveredMs = elapsedMilliseconds(timing.updatedAt, event.occurredAt)
          }
        } catch {
          // A timing read must never block provider status reconciliation.
        }
      }
      const recordSpan = deliveryResultSpan("bob.delivery_result.record", event)
      if (providerAcceptedToDeliveredMs !== undefined) {
        Object.assign(recordSpan, { providerAcceptedToDeliveredMs })
      }
      const readyFollowups = await runTelemetry(
        withTraceparent(
          withBobSpan(
            deliveryResultSpan("bob.delivery_result.accept", event),
            withBobSpan(
              recordSpan,
              Effect.flatMap(DeliveryStore, (delivery) => delivery.recordProviderEvent(event))
            )
          ),
          request.headers.get("traceparent")
        )
      )
      await composition.runtime.runPromise(
        publishDeliveryFollowups(jobQueue().outbound, readyFollowups, event.correlationId)
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
        withTraceparent(
          withBobSpan(
            {
              name: "bob.outbox.claim",
              correlationId,
              outboxId,
              feature: "delivery"
            },
            Effect.flatMap(DeliveryStore, (delivery) =>
              delivery.claimOutbox(outboxId, 60_000, dispatchGeneration)
            )
          ),
          request.headers.get("traceparent")
        )
      )
      return claim === undefined
        ? json(
            {
              claim: null,
              disposition: await composition.runtime.runPromise(
                Effect.flatMap(DeliveryStore, (delivery) =>
                  delivery.outboxDisposition(outboxId, dispatchGeneration)
                )
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
        withTraceparent(
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
              Effect.flatMap(DeliveryStore, (delivery) => delivery.recordResult(result))
            )
          ),
          request.headers.get("traceparent")
        )
      )
      await composition.runtime.runPromise(
        publishDeliveryFollowups(
          jobQueue().outbound,
          readyFollowups,
          result.correlationId ?? result.outboxId
        )
      )
      return json({ ok: true })
    }

    if (request.method === "POST" && url.pathname === "/internal/tools") {
      const command = Schema.decodeUnknownSync(ToolCommand)(await readJson(request))
      const authority = toolAuthority(request)
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
            withTraceparent(
              withBobSpan(
                {
                  name: "bob.tool.execute",
                  correlationId,
                  feature: featureForToolName(composition.profile, command.name),
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
                    await wakeSettledConversationRun(composition, command.runId)
                  })
                  return result
                })
              ),
              request.headers.get("traceparent")
            )
          )
        )
      } finally {
        await composition.runtime.runPromise(
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

    if (request.method === "POST" && url.pathname === "/internal/agent/operations/load") {
      const input = Schema.decodeUnknownSync(AgentRunOperationsLoadRequest)(await readJson(request))
      return json({
        operations: await composition.runtime.runPromise(
          Effect.flatMap(AgentRunStore, (runs) => runs.loadOperations(input.runId, input.attemptId))
        )
      })
    }

    if (request.method === "POST" && url.pathname === "/internal/agent/operations") {
      const input = Schema.decodeUnknownSync(AgentRunOperationAppendRequest)(
        await readJson(request)
      )
      return json({
        status: await composition.runtime.runPromise(
          Effect.flatMap(AgentRunStore, (runs) =>
            runs.appendOperation(input.operation, input.attemptId)
          )
        )
      })
    }

    if (request.method === "POST" && url.pathname === "/internal/agent-runs/acquire") {
      const input = Schema.decodeUnknownSync(AcquireAgentRun)(await readJson(request))
      return json(
        await composition.runtime.runPromise(
          Effect.flatMap(AgentRunGateway, (gateway) => gateway.acquire(input))
        )
      )
    }

    if (request.method === "POST" && url.pathname === "/internal/agent-runs/renew") {
      const input = Schema.decodeUnknownSync(RenewAgentRunLease)(await readJson(request))
      return json(
        await composition.runtime.runPromise(
          Effect.flatMap(AgentRunGateway, (gateway) => gateway.renew(input))
        )
      )
    }

    if (request.method === "POST" && url.pathname === "/internal/agent-runs/control") {
      const authority = Schema.decodeUnknownSync(AgentRunAttemptAuthority)(await readJson(request))
      return json(
        await composition.runtime.runPromise(
          Effect.flatMap(AgentRunGateway, (gateway) => gateway.readControl(authority))
        )
      )
    }

    if (request.method === "POST" && url.pathname === "/internal/agent-runs/checkpoint") {
      const input = Schema.decodeUnknownSync(AppendAgentRunCheckpoint)(await readJson(request))
      return json({
        status: await composition.runtime.runPromise(
          Effect.flatMap(AgentRunGateway, (gateway) => gateway.appendCheckpoint(input))
        )
      })
    }

    if (request.method === "POST" && url.pathname === "/internal/agent-runs/outcome") {
      const input = Schema.decodeUnknownSync(RecordAgentRunOutcome)(await readJson(request))
      return json({
        status: await composition.runtime.runPromise(
          Effect.flatMap(AgentRunGateway, (gateway) => gateway.recordOutcome(input))
        )
      })
    }

    if (request.method === "GET" && url.pathname === "/api/settings") {
      const settings = await composition.runtime.runPromise(
        Effect.flatMap(OwnerSettingsStore, (store) => store.get(authenticatedOwnerId!))
      )
      const connections = await composition.runtime.runPromise(
        Effect.flatMap(OwnerSettingsStore, (store) => store.connections(authenticatedOwnerId!))
      )
      return json({
        settings,
        connections
      })
    }

    if (request.method === "PUT" && url.pathname === "/api/settings") {
      const input = Schema.decodeUnknownSync(OwnerSettingsUpdate)(await readJson(request))
      const settings = await composition.runtime.runPromise(
        Effect.flatMap(OwnerSettingsStore, (store) =>
          store.update(authenticatedOwnerId!, input, idempotencyKey(request))
        )
      )
      const connections = await composition.runtime.runPromise(
        Effect.flatMap(OwnerSettingsStore, (store) => store.connections(authenticatedOwnerId!))
      )
      return json({
        settings,
        connections
      })
    }

    for (const route of composition.modules.ownerRoutes) {
      const result = await route.handle({
        request,
        url,
        ownerId: authenticatedOwnerId!,
        readJson: () => readJson(request),
        idempotencyKey: () => idempotencyKey(request)
      })
      if (result !== undefined) return json(result.body, result.status)
    }

    if (request.method === "GET" && url.pathname === "/api/alerts") {
      return json({
        alerts: await composition.runtime.runPromise(
          Effect.flatMap(AlertStore, (alerts) => alerts.list(authenticatedOwnerId!))
        )
      })
    }

    const alertReconcile = url.pathname.match(/^\/api\/alerts\/([^/]+)\/reconcile$/)
    if (request.method === "POST" && alertReconcile !== null) {
      idempotencyKey(request)
      const alertId = decodeURIComponent(alertReconcile[1]!)
      const alert = await composition.runtime.runPromise(
        Effect.flatMap(AlertStore, (alerts) => alerts.get(authenticatedOwnerId!, alertId))
      )
      if (alert === undefined) return json({ code: "not_found" }, 404)
      await composition.runtime.runPromise(
        Effect.flatMap(AlertStore, (alerts) =>
          alerts.setState(authenticatedOwnerId!, alert.id, "reconciling")
        )
      )
      if (alert.code === "inbound_exhausted") {
        const decision = await composition.runtime.runPromise(
          Effect.flatMap(ConversationStore, (conversations) =>
            conversations.prepareInboundRecovery(alert.objectId, 4)
          )
        )
        if (decision === "recover") {
          await jobQueue().inbound.publish({
            eventId: alert.objectId,
            enqueuedAt: new Date().toISOString()
          })
          await composition.runtime.runPromise(
            Effect.flatMap(ConversationStore, (conversations) =>
              conversations.markEnqueued(alert.objectId, new Date().toISOString())
            )
          )
          await composition.runtime.runPromise(
            Effect.flatMap(AlertStore, (alerts) =>
              alerts.setState(authenticatedOwnerId!, alert.id, "resolved")
            )
          )
        }
        return json({ status: decision })
      }
      if (alert.code === "outbound_exhausted") {
        const decision = await composition.runtime.runPromise(
          Effect.flatMap(DeliveryStore, (delivery) =>
            delivery.prepareOutboundRecovery(alert.objectId, 4)
          )
        )
        if (decision.status === "recover") {
          await jobQueue().outbound.publish({
            outboxId: alert.objectId,
            dispatchGeneration: decision.dispatchGeneration,
            enqueuedAt: new Date().toISOString()
          })
          await composition.runtime.runPromise(
            Effect.flatMap(DeliveryStore, (delivery) =>
              delivery.markEnqueued(
                alert.objectId,
                new Date().toISOString(),
                decision.dispatchGeneration
              )
            )
          )
          await composition.runtime.runPromise(
            Effect.flatMap(AlertStore, (alerts) =>
              alerts.setState(authenticatedOwnerId!, alert.id, "resolved")
            )
          )
        } else if (decision.status === "resolved") {
          await composition.runtime.runPromise(
            Effect.flatMap(AlertStore, (alerts) =>
              alerts.setState(authenticatedOwnerId!, alert.id, "resolved")
            )
          )
        }
        return json({ status: decision.status })
      }
      if (alert.code === "delivery_uncertain" || alert.code === "delivery_result_exhausted") {
        let status = await composition.runtime.runPromise(
          Effect.flatMap(DeliveryStore, (delivery) => delivery.reconcileOutbox(alert.objectId))
        )
        if (status === "pending") {
          const target = await composition.runtime.runPromise(
            Effect.flatMap(DeliveryStore, (delivery) =>
              delivery.reconciliationTarget(alert.objectId)
            )
          )
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
                await composition.runtime.runPromise(
                  Effect.flatMap(DeliveryStore, (delivery) =>
                    delivery.recordResult(provider.result)
                  )
                )
                status = await composition.runtime.runPromise(
                  Effect.flatMap(DeliveryStore, (delivery) =>
                    delivery.reconcileOutbox(alert.objectId)
                  )
                )
              }
            }
          }
        }
        if (status === "resolved") {
          await composition.runtime.runPromise(
            Effect.flatMap(AlertStore, (alerts) =>
              alerts.setState(authenticatedOwnerId!, alert.id, "resolved")
            )
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
          await composition.runtime.runPromise(
            Effect.flatMap(AlertStore, (alerts) =>
              alerts.setState(authenticatedOwnerId!, alert.id, "resolved")
            )
          )
        }
        return json({ status: status.configured === true ? "resolved" : "pending" })
      }
      await composition.runtime.runPromise(
        Effect.flatMap(AlertStore, (alerts) =>
          alerts.setState(authenticatedOwnerId!, alert.id, "resolved")
        )
      )
      return json({ status: "manual_action_required" })
    }

    if (request.method === "GET" && url.pathname === "/api/memory/candidates") {
      return json({
        candidates: await composition.runtime.runPromise(
          Effect.flatMap(MemoryStore, (memory) => memory.listCandidates(authenticatedOwnerId!))
        )
      })
    }

    const memoryConfirm = url.pathname.match(/^\/api\/memory\/candidates\/([^/]+)\/confirm$/)
    if (request.method === "POST" && memoryConfirm !== null) {
      const revisionId = await composition.runtime.runPromise(
        Effect.flatMap(MemoryStore, (memory) =>
          memory.confirm(
            authenticatedOwnerId!,
            decodeURIComponent(memoryConfirm[1]!),
            "owner_ui",
            idempotencyKey(request)
          )
        )
      )
      return json({ revisionId })
    }

    const memoryCorrect = url.pathname.match(/^\/api\/memory\/candidates\/([^/]+)\/correct$/)
    if (request.method === "POST" && memoryCorrect !== null) {
      const input = Schema.decodeUnknownSync(MemoryCandidateCorrection)(await readJson(request))
      const candidateId = await composition.runtime.runPromise(
        Effect.flatMap(MemoryStore, (memory) =>
          memory.correct(
            authenticatedOwnerId!,
            decodeURIComponent(memoryCorrect[1]!),
            input.canonicalText,
            idempotencyKey(request)
          )
        )
      )
      return json({ candidateId })
    }

    const memoryReject = url.pathname.match(/^\/api\/memory\/candidates\/([^/]+)\/reject$/)
    if (request.method === "POST" && memoryReject !== null) {
      await composition.runtime.runPromise(
        Effect.flatMap(MemoryStore, (memory) =>
          memory.reject(
            authenticatedOwnerId!,
            decodeURIComponent(memoryReject[1]!),
            idempotencyKey(request)
          )
        )
      )
      return json({ ok: true })
    }

    if (request.method === "GET" && url.pathname === "/api/agent/status") {
      const response = await fetch(`${composition.config.AGENT_ADMIN_URL}/v1/admin/auth/status`, {
        headers: {
          "x-bob-caller-token": composition.config.AGENT_CALLER_SECRET,
          "x-bob-owner-id": authenticatedOwnerId!
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
            "x-bob-caller-token": composition.config.AGENT_CALLER_SECRET,
            "x-bob-owner-id": authenticatedOwnerId!
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
    if (error instanceof AgentRunAuthorityLost) return json({ code: "authority_lost" }, 409)
    if (error instanceof AgentRunCheckpointConflict)
      return json({ code: "checkpoint_conflict" }, 409)
    if (error instanceof AgentRunGatewayUnavailable)
      return json({ code: "gateway_unavailable" }, 503)
    const status = error instanceof RequestBodyTooLargeError ? 413 : 400
    return json({ code: status === 413 ? "body_too_large" : "invalid_request" }, status)
  }
}
