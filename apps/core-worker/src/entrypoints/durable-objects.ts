import { InboundJob } from "@bob/contracts/jobs"
import { withBobRootSpan, withBobSpan, type BobSpan } from "@bob/observability/effect"
import {
  externalParentFromTraceparent,
  injectCurrentTraceparent
} from "@bob/observability/propagation"
import { eq } from "drizzle-orm"
import { Effect, Schema } from "effect"

import type { CoreBindings } from "../bindings.ts"

import { composeCore } from "../composition.ts"
import { outboxMessages } from "../modules/delivery/schema.ts"
import { processInbound } from "../process-inbound.ts"
import { makeCoreTelemetryInvocation, scheduleTelemetryWork } from "../telemetry.ts"

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

export class OwnerRunCoordinator implements DurableObject {
  constructor(
    private readonly state: DurableObjectState,
    private readonly bindings: CoreBindings
  ) {}

  async fetch(request: Request): Promise<Response> {
    if (request.method !== "POST" || new URL(request.url).pathname !== "/run") {
      return new Response(null, { status: 404 })
    }
    try {
      const job = Schema.decodeUnknownSync(InboundJob)(await request.json())
      const telemetry = makeCoreTelemetryInvocation(this.bindings)
      const suppliedCorrelationId = request.headers.get("x-bob-correlation-id")
      const correlationId =
        suppliedCorrelationId === null
          ? (job.correlationId ?? job.eventId)
          : Schema.decodeUnknownSync(Schema.String.check(Schema.isUUID()))(suppliedCorrelationId)
      const incomingTraceparent = request.headers.get("traceparent") ?? job.traceparent
      const state = this.state
      const bindings = this.bindings
      const composition = composeCore(bindings)
      const processed = telemetry.runPromise(
        withTraceparentParent(
          incomingTraceparent,
          withBobSpan(
            {
              name: "bob.coordinator.run",
              correlationId,
              feature: "assistant"
            },
            Effect.gen(function* () {
              const headers = yield* injectCurrentTraceparent()
              const traceparent = headers.get("traceparent") ?? undefined
              yield* promiseEffect(() =>
                state.blockConcurrencyWhile(() =>
                  processInbound(
                    job.eventId,
                    bindings,
                    composition,
                    traceparent,
                    telemetry,
                    correlationId
                  )
                )
              )
            })
          )
        )
      )
      scheduleTelemetryWork(this.state, processed.then(telemetry.flush, telemetry.flush))
      await processed
      return Response.json({ ok: true })
    } catch {
      return Response.json({ code: "run_failed" }, { status: 503 })
    }
  }
}

export class ReminderClock implements DurableObject {
  constructor(
    private readonly state: DurableObjectState,
    private readonly bindings: CoreBindings
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
    const telemetry = makeCoreTelemetryInvocation(this.bindings)
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
    const composition = composeCore(this.bindings)
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
      const span: BobSpan = {
        name: "bob.reminder.dispatch",
        correlationId,
        feature: "reminders",
        outboxId,
        ...(occurrenceId === undefined ? {} : { reminderOccurrenceId: occurrenceId })
      }
      const outboundQueue = this.bindings.OUTBOUND_QUEUE
      await telemetry.runPromise(
        withBobRootSpan(
          span,
          Effect.gen(function* () {
            const headers = yield* injectCurrentTraceparent()
            const traceparent = headers.get("traceparent")
            yield* promiseEffect(() =>
              outboundQueue.send({
                outboxId,
                correlationId,
                ...(traceparent === null ? {} : { traceparent })
              })
            )
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
