import { InboundJob } from "@bob/contracts/jobs"
import { recordDecision, withBobSpan, type BobDecisionCode } from "@bob/observability/effect"
import {
  externalParentFromTraceparent,
  injectCurrentTraceparent
} from "@bob/observability/propagation"
import { Effect, Schema } from "effect"

import type { CoreBindings } from "../bindings.ts"

import { composeCore } from "../composition.ts"
import { processConversationTurn } from "../process-inbound.ts"
import { makeCoreTelemetryInvocation, scheduleTelemetryWork } from "../telemetry.ts"

export interface CoreDurableDependencies {
  readonly composeCore: typeof composeCore
  readonly processConversationTurn: typeof processConversationTurn
  readonly makeCoreTelemetryInvocation: typeof makeCoreTelemetryInvocation
}

const coreDurableDependencies: CoreDurableDependencies = {
  composeCore,
  processConversationTurn,
  makeCoreTelemetryInvocation
}

function promiseEffect<A>(operation: (signal: AbortSignal) => PromiseLike<A>) {
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

async function scheduleEarliestAlarm(
  storage: DurableObjectStorage,
  scheduled: Date
): Promise<void> {
  const current = await storage.getAlarm()
  if (current === null || scheduled.getTime() < current) await storage.setAlarm(scheduled)
}

async function requestAgentSteer(
  composition: ReturnType<typeof composeCore>,
  runId: string,
  headers: Headers
): Promise<"aborted_model" | "queued" | "missing" | "unavailable"> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort("steer_timeout"), 3_000)
  try {
    const response = await fetch(`${composition.config.AGENT_URL}/v1/steer`, {
      method: "POST",
      headers,
      body: JSON.stringify({ runId }),
      signal: controller.signal
    })
    if (!response.ok) return "unavailable"
    const result = Schema.decodeUnknownSync(
      Schema.Struct({ status: Schema.Literals(["aborted_model", "queued", "missing"]) })
    )(await response.json())
    return result.status
  } catch {
    // D1 revision checks suppress stale replies when live steering is unavailable.
    return "unavailable"
  } finally {
    clearTimeout(timeout)
  }
}

export class OwnerRunCoordinator implements DurableObject {
  constructor(
    private readonly state: DurableObjectState,
    private readonly bindings: CoreBindings,
    private readonly dependencies: CoreDurableDependencies = coreDurableDependencies
  ) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    const path = url.pathname
    if (request.method === "POST" && path === "/wake") {
      const requestedAt = url.searchParams.get("at")
      const scheduled = requestedAt === null ? new Date() : new Date(requestedAt)
      if (!Number.isFinite(scheduled.getTime())) {
        return Response.json({ code: "invalid_wake_time" }, { status: 400 })
      }
      await scheduleEarliestAlarm(this.state.storage, scheduled)
      return Response.json({ ok: true })
    }
    if (request.method !== "POST" || path !== "/run") {
      return new Response(null, { status: 404 })
    }
    try {
      const job = Schema.decodeUnknownSync(InboundJob)(await request.json())
      const telemetry = this.dependencies.makeCoreTelemetryInvocation(this.bindings)
      const suppliedCorrelationId = request.headers.get("x-bob-correlation-id")
      const correlationId =
        suppliedCorrelationId === null
          ? (job.correlationId ?? job.eventId)
          : Schema.decodeUnknownSync(Schema.String.check(Schema.isUUID()))(suppliedCorrelationId)
      const incomingTraceparent = request.headers.get("traceparent") ?? job.traceparent
      const state = this.state
      const bindings = this.bindings
      const composition = this.dependencies.composeCore(bindings)
      const accepted = telemetry.runPromise(
        withTraceparentParent(
          incomingTraceparent,
          withBobSpan(
            {
              name: "bob.coordinator.run",
              correlationId,
              feature: "assistant"
            },
            Effect.gen(function* () {
              return yield* withBobSpan(
                {
                  name: "bob.turn.collect",
                  correlationId,
                  feature: "assistant"
                },
                Effect.gen(function* () {
                  const headers = yield* injectCurrentTraceparent()
                  const traceparent = headers.get("traceparent") ?? incomingTraceparent
                  const offered = yield* promiseEffect(() =>
                    state.blockConcurrencyWhile(async () => {
                      const stored = await composition.services.turns.offer(
                        job.eventId,
                        traceparent
                      )
                      await scheduleEarliestAlarm(state.storage, new Date(stored.quietUntil))
                      return stored
                    })
                  )
                  yield* recordDecision({
                    name: "bob.state.transition",
                    code: offered.revision === 1 ? "new" : "burst_append",
                    outcome: "applied",
                    conversationRevision: offered.revision
                  })
                  yield* Effect.annotateCurrentSpan({
                    "bob.conversation.turn_id": offered.turnId,
                    "bob.conversation.revision": offered.revision
                  })
                  return { offered, collectTraceparent: traceparent }
                })
              )
            })
          )
        )
      )
      scheduleTelemetryWork(this.state, accepted.then(telemetry.flush, telemetry.flush))
      const { offered, collectTraceparent } = await accepted
      if (offered.appended && offered.activeRunId !== undefined) {
        const settling = await composition.services.turns.markSettling(
          offered.turnId,
          offered.revision,
          offered.activeRunId
        )
        if (!settling) {
          return Response.json(
            { ok: true, turnId: offered.turnId, revision: offered.revision },
            { status: 202 }
          )
        }
        await scheduleEarliestAlarm(state.storage, new Date(settling.claimExpiresAt))
        await telemetry.runPromise(
          withTraceparentParent(
            collectTraceparent,
            withBobSpan(
              {
                name: "bob.run.cancel_request",
                correlationId,
                runId: offered.activeRunId,
                conversationTurnId: offered.turnId,
                conversationRevision: offered.revision,
                feature: "assistant"
              },
              Effect.gen(function* () {
                const headers = yield* injectCurrentTraceparent({
                  "content-type": "application/json",
                  "CF-Access-Client-Id": composition.config.AGENT_ACCESS_CLIENT_ID,
                  "CF-Access-Client-Secret": composition.config.AGENT_ACCESS_CLIENT_SECRET,
                  "x-bob-correlation-id": correlationId
                })
                const status = yield* promiseEffect(() =>
                  requestAgentSteer(composition, offered.activeRunId!, headers)
                )
                const code: BobDecisionCode =
                  status === "aborted_model" ? "abort_model" : "wait_effect"
                yield* recordDecision({
                  name: "bob.decision.steering",
                  code,
                  outcome: "applied",
                  conversationRevision: offered.revision
                })
                return status
              })
            )
          )
        )
        scheduleTelemetryWork(this.state, telemetry.flush())
      }
      return Response.json(
        { ok: true, turnId: offered.turnId, revision: offered.revision },
        { status: 202 }
      )
    } catch {
      return Response.json({ code: "run_failed" }, { status: 503 })
    }
  }

  async alarm(): Promise<void> {
    await this.runReadyTurn()
  }

  private async runReadyTurn(): Promise<void> {
    const telemetry = this.dependencies.makeCoreTelemetryInvocation(this.bindings)
    const composition = this.dependencies.composeCore(this.bindings)
    while (true) {
      const ready = await this.state.blockConcurrencyWhile(() =>
        composition.services.turns.claimReady()
      )
      if (ready === undefined) break
      await scheduleEarliestAlarm(this.state.storage, new Date(ready.claimExpiresAt))
      const processed = this.dependencies.processConversationTurn(
        ready,
        this.bindings,
        composition,
        telemetry
      )
      scheduleTelemetryWork(this.state, processed.then(telemetry.flush, telemetry.flush))
      await processed
    }
    const nextWakeAt = await composition.services.turns.nextWakeAt()
    if (nextWakeAt !== undefined) {
      await scheduleEarliestAlarm(this.state.storage, new Date(nextWakeAt))
    }
  }
}
