import { InboundJob } from "@bob/contracts/jobs"
import { recordDecision, withBobSpan } from "@bob/observability/effect"
import {
  externalParentFromTraceparent,
  injectCurrentTraceparent
} from "@bob/observability/propagation"
import { Effect, Schema } from "effect"

import type { CoreBindings } from "../bindings.ts"

import { composeCore } from "../composition.ts"
import { processConversationTurn } from "../process-inbound.ts"
import { makeOwnerTurnEngine } from "../runtime/owner-turn-engine.ts"
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
    return Schema.decodeUnknownSync(
      Schema.Struct({ status: Schema.Literals(["aborted_model", "queued", "missing"]) })
    )(await response.json()).status
  } catch {
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

  private engine(
    composition: ReturnType<typeof composeCore>,
    telemetry: ReturnType<typeof makeCoreTelemetryInvocation>
  ) {
    return makeOwnerTurnEngine({
      turns: composition.services.turns,
      serialize: (operation) => this.state.blockConcurrencyWhile(operation),
      schedule: (at) => scheduleEarliestAlarm(this.state.storage, at),
      process: (snapshot) =>
        this.dependencies.processConversationTurn(snapshot, this.bindings, composition, telemetry),
      steer: async (runId, correlationId, traceparent, turn) => {
        const effect = withTraceparentParent(
          traceparent,
          withBobSpan(
            {
              name: "bob.run.cancel_request",
              correlationId,
              runId,
              conversationTurnId: turn.turnId,
              conversationRevision: turn.revision,
              feature: "assistant"
            },
            Effect.gen(function* () {
              const headers = yield* injectCurrentTraceparent({
                "content-type": "application/json",
                "CF-Access-Client-Id": composition.config.AGENT_ACCESS_CLIENT_ID,
                "CF-Access-Client-Secret": composition.config.AGENT_ACCESS_CLIENT_SECRET,
                "x-bob-correlation-id": correlationId
              })
              const status = yield* Effect.promise(() =>
                requestAgentSteer(composition, runId, headers)
              )
              yield* recordDecision({
                name: "bob.decision.steering",
                code: status === "aborted_model" ? "abort_model" : "wait_effect",
                outcome: "applied"
              })
              return status
            })
          )
        )
        return telemetry.runPromise(effect)
      }
    })
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    if (request.method === "POST" && url.pathname === "/wake") {
      const requestedAt = url.searchParams.get("at")
      const scheduled = requestedAt === null ? new Date() : new Date(requestedAt)
      if (!Number.isFinite(scheduled.getTime())) {
        return Response.json({ code: "invalid_wake_time" }, { status: 400 })
      }
      await scheduleEarliestAlarm(this.state.storage, scheduled)
      return Response.json({ ok: true })
    }
    if (request.method !== "POST" || url.pathname !== "/run") {
      return new Response(null, { status: 404 })
    }

    try {
      const job = Schema.decodeUnknownSync(InboundJob)(await request.json())
      const correlationId =
        request.headers.get("x-bob-correlation-id") ?? job.correlationId ?? job.eventId
      const incomingTraceparent = request.headers.get("traceparent") ?? job.traceparent
      const composition = this.dependencies.composeCore(this.bindings)
      const telemetry = this.dependencies.makeCoreTelemetryInvocation(this.bindings)
      const engine = this.engine(composition, telemetry)
      const accepted = telemetry.runPromise(
        withTraceparentParent(
          incomingTraceparent,
          withBobSpan(
            { name: "bob.coordinator.run", correlationId, feature: "assistant" },
            withBobSpan(
              { name: "bob.turn.collect", correlationId, feature: "assistant" },
              Effect.gen(function* () {
                const headers = yield* injectCurrentTraceparent()
                const traceparent = headers.get("traceparent") ?? incomingTraceparent
                const offered = yield* Effect.promise(() =>
                  engine.accept(job, correlationId, traceparent)
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
                return offered
              })
            )
          )
        )
      )
      scheduleTelemetryWork(this.state, accepted.then(telemetry.flush, telemetry.flush))
      const offered = await accepted
      return Response.json(
        { ok: true, turnId: offered.turnId, revision: offered.revision },
        { status: 202 }
      )
    } catch {
      return Response.json({ code: "run_failed" }, { status: 503 })
    }
  }

  async alarm(): Promise<void> {
    const telemetry = this.dependencies.makeCoreTelemetryInvocation(this.bindings)
    const composition = this.dependencies.composeCore(this.bindings)
    const processed = this.engine(composition, telemetry).wake()
    scheduleTelemetryWork(this.state, processed.then(telemetry.flush, telemetry.flush))
    await processed
  }
}
