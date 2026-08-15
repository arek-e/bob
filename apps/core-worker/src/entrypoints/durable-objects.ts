import { InboundJob } from "@bob/contracts/jobs"
import {
  recordDecision,
  withBobRootSpan,
  withBobSpan,
  type BobDecisionCode,
  type BobSpan
} from "@bob/observability/effect"
import {
  externalParentFromTraceparent,
  injectCurrentTraceparent
} from "@bob/observability/propagation"
import { eq } from "drizzle-orm"
import { Effect, Schema } from "effect"

import type { CoreBindings } from "../bindings.ts"

import { composeCore } from "../composition.ts"
import { outboxMessages } from "../modules/delivery/schema.ts"
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

interface DispatchOutbox {
  readonly correlationId: string
  readonly actionTargetType: string | null
  readonly actionTargetId: string | null
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

function safeUuid(value: string | null): string | undefined {
  if (value === null) return undefined
  try {
    return Schema.decodeUnknownSync(Schema.String.check(Schema.isUUID()))(value)
  } catch {
    return undefined
  }
}

function reminderOccurrence(item: DispatchOutbox | undefined): string | undefined {
  return item?.actionTargetType === "reminder_occurrence"
    ? safeUuid(item.actionTargetId)
    : undefined
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

export class ReminderClock implements DurableObject {
  constructor(
    private readonly state: DurableObjectState,
    private readonly bindings: CoreBindings,
    private readonly dependencies: CoreDurableDependencies = coreDurableDependencies
  ) {}

  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname
    if (request.method !== "POST" || (path !== "/reconcile" && path !== "/command")) {
      return new Response(null, { status: 404 })
    }
    try {
      const suppliedCorrelationId = request.headers.get("x-bob-correlation-id")
      const correlationId =
        suppliedCorrelationId === null
          ? crypto.randomUUID()
          : Schema.decodeUnknownSync(Schema.String.check(Schema.isUUID()))(suppliedCorrelationId)
      const traceparent = request.headers.get("traceparent") ?? undefined
      return Response.json(
        await this.runAccepted(correlationId, traceparent, async (telemetry) => {
          if (path === "/command") {
            const command = Schema.decodeUnknownSync(
              Schema.Struct({
                id: Schema.String,
                reminderId: Schema.String,
                scheduleRevision: Schema.Int,
                command: Schema.Literals(["upsert", "remove", "reconcile"])
              })
            )(await request.json())
            const versionKey = `reminder-revision:${command.reminderId}`
            const previous = (await this.state.storage.get<number>(versionKey)) ?? 0
            if (command.scheduleRevision <= previous) {
              return { ok: true, duplicate: true }
            }
            const count = await this.runClockUntraced(correlationId, telemetry)
            await this.state.storage.put(versionKey, command.scheduleRevision)
            return { ok: true, duplicate: false, dueCount: count }
          }
          const count = await this.runClockUntraced(correlationId, telemetry)
          return { ok: true, dueCount: count }
        })
      )
    } catch {
      return Response.json({ code: "clock_failed" }, { status: 503 })
    }
  }

  async alarm(): Promise<void> {
    await this.runClock()
  }

  private async runClock(): Promise<number> {
    const correlationId = crypto.randomUUID()
    return this.runAccepted(correlationId, undefined, (telemetry) =>
      this.runClockUntraced(correlationId, telemetry)
    )
  }

  private async runAccepted<A>(
    correlationId: string,
    incomingTraceparent: string | undefined,
    operation: (telemetry: ReturnType<typeof makeCoreTelemetryInvocation>) => Promise<A>
  ): Promise<A> {
    const telemetry = this.dependencies.makeCoreTelemetryInvocation(this.bindings)
    const program = withTraceparentParent(
      incomingTraceparent,
      withBobSpan(
        {
          name: "bob.reminder.accept",
          correlationId,
          feature: "reminders"
        },
        promiseEffect(() => operation(telemetry))
      )
    )
    const result = telemetry.runPromise(program)
    scheduleTelemetryWork(this.state, result.then(telemetry.flush, telemetry.flush))
    return result
  }

  private async runClockUntraced(
    fallbackCorrelationId: string,
    telemetry: ReturnType<typeof makeCoreTelemetryInvocation>
  ): Promise<number> {
    const composition = this.dependencies.composeCore(this.bindings)
    const outboxIds = await composition.services.reminders.claimDueAndCreateOutbox(
      composition.config.OWNER_ID,
      60_000
    )
    for (const outboxId of outboxIds) {
      const [outbox] = await composition.database
        .select({
          correlationId: outboxMessages.correlationId,
          actionTargetType: outboxMessages.actionTargetType,
          actionTargetId: outboxMessages.actionTargetId
        })
        .from(outboxMessages)
        .where(eq(outboxMessages.id, outboxId))
        .limit(1)
      const correlationId = outbox?.correlationId ?? fallbackCorrelationId
      const occurrenceId = reminderOccurrence(outbox)
      const span: BobSpan =
        occurrenceId === undefined
          ? {
              name: "bob.reminder.dispatch",
              correlationId,
              feature: "reminders",
              outboxId
            }
          : {
              name: "bob.reminder.dispatch",
              correlationId,
              feature: "reminders",
              outboxId,
              reminderOccurrenceId: occurrenceId
            }
      const outboundQueue = this.bindings.OUTBOUND_QUEUE
      await telemetry.runPromise(
        withBobRootSpan(
          span,
          Effect.gen(function* () {
            const headers = yield* injectCurrentTraceparent()
            const traceparent = headers.get("traceparent")
            const message =
              traceparent === null
                ? { outboxId, correlationId }
                : { outboxId, correlationId, traceparent }
            yield* promiseEffect(() => outboundQueue.send(message))
            yield* promiseEffect(() =>
              composition.services.delivery.markEnqueued(outboxId, new Date().toISOString())
            )
          })
        )
      )
    }
    const nextDue = await composition.services.reminders.nextDue(composition.config.OWNER_ID)
    if (nextDue === undefined) await this.state.storage.deleteAlarm()
    else await this.state.storage.setAlarm(new Date(nextDue))
    return outboxIds.length
  }
}
