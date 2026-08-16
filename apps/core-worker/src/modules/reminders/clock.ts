import { withBobRootSpan, withBobSpan, type BobSpan } from "@bob/observability/effect"
import {
  externalParentFromTraceparent,
  injectCurrentTraceparent
} from "@bob/observability/propagation"
import { eq } from "drizzle-orm"
import { Effect, Schema } from "effect"

import type { TransitionalBindings } from "../../bindings.ts"

import { makeCoreTelemetryInvocation, scheduleTelemetryWork } from "../../telemetry.ts"
import { composeTransitional } from "../../transitional-composition.ts"
import { outboxMessages } from "../delivery/schema.ts"

export interface ReminderClockDependencies {
  readonly composeCore: typeof composeTransitional
  readonly makeCoreTelemetryInvocation: typeof makeCoreTelemetryInvocation
}

const defaultDependencies: ReminderClockDependencies = {
  composeCore: composeTransitional,
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

function occurrenceId(
  item: { actionTargetType: string | null; actionTargetId: string | null } | undefined
) {
  if (item?.actionTargetType !== "reminder_occurrence" || item.actionTargetId === null)
    return undefined
  try {
    return Schema.decodeUnknownSync(Schema.String.check(Schema.isUUID()))(item.actionTargetId)
  } catch {
    return undefined
  }
}

export class ReminderClock implements DurableObject {
  constructor(
    private readonly state: DurableObjectState,
    private readonly bindings: TransitionalBindings,
    private readonly dependencies: ReminderClockDependencies = defaultDependencies
  ) {}

  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname
    if (request.method !== "POST" || (path !== "/reconcile" && path !== "/command")) {
      return new Response(null, { status: 404 })
    }
    try {
      const supplied = request.headers.get("x-bob-correlation-id")
      const correlationId =
        supplied === null
          ? crypto.randomUUID()
          : Schema.decodeUnknownSync(Schema.String.check(Schema.isUUID()))(supplied)
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
            if (command.scheduleRevision <= previous) return { ok: true, duplicate: true }
            const count = await this.runClockUntraced(correlationId, telemetry)
            await this.state.storage.put(versionKey, command.scheduleRevision)
            return { ok: true, duplicate: false, dueCount: count }
          }
          return { ok: true, dueCount: await this.runClockUntraced(correlationId, telemetry) }
        })
      )
    } catch {
      return Response.json({ code: "clock_failed" }, { status: 503 })
    }
  }

  async alarm(): Promise<void> {
    await this.runClock()
  }

  private runClock(): Promise<number> {
    const correlationId = crypto.randomUUID()
    return this.runAccepted(correlationId, undefined, (telemetry) =>
      this.runClockUntraced(correlationId, telemetry)
    )
  }

  private runAccepted<A>(
    correlationId: string,
    traceparent: string | undefined,
    operation: (telemetry: ReturnType<typeof makeCoreTelemetryInvocation>) => Promise<A>
  ): Promise<A> {
    const telemetry = this.dependencies.makeCoreTelemetryInvocation(this.bindings)
    const result = telemetry.runPromise(
      withTraceparentParent(
        traceparent,
        withBobSpan(
          { name: "bob.reminder.accept", correlationId, feature: "reminders" },
          promiseEffect(() => operation(telemetry))
        )
      )
    )
    scheduleTelemetryWork(this.state, result.then(telemetry.flush, telemetry.flush))
    return result
  }

  private async runClockUntraced(
    fallbackCorrelationId: string,
    telemetry: ReturnType<typeof makeCoreTelemetryInvocation>
  ): Promise<number> {
    const composition = this.dependencies.composeCore(this.bindings)
    const reminders = composition.extensions?.reminders ?? composition.services.reminders
    const outboxIds = await reminders.claimDueAndCreateOutbox(composition.config.OWNER_ID, 60_000)
    for (const outboxId of outboxIds) {
      const [outbox] = await (composition.applicationStorage ?? composition.database)
        .select({
          correlationId: outboxMessages.correlationId,
          actionTargetType: outboxMessages.actionTargetType,
          actionTargetId: outboxMessages.actionTargetId
        })
        .from(outboxMessages)
        .where(eq(outboxMessages.id, outboxId))
        .limit(1)
      const correlationId = outbox?.correlationId ?? fallbackCorrelationId
      const targetId = occurrenceId(outbox)
      const span: BobSpan =
        targetId === undefined
          ? { name: "bob.reminder.dispatch", correlationId, feature: "reminders", outboxId }
          : {
              name: "bob.reminder.dispatch",
              correlationId,
              feature: "reminders",
              outboxId,
              reminderOccurrenceId: targetId
            }
      const outboundQueue = this.bindings.OUTBOUND_QUEUE
      await telemetry.runPromise(
        withBobRootSpan(
          span,
          Effect.gen(function* () {
            const headers = yield* injectCurrentTraceparent()
            const traceparent = headers.get("traceparent")
            yield* promiseEffect(() =>
              outboundQueue.send(
                traceparent === null
                  ? { outboxId, correlationId }
                  : { outboxId, correlationId, traceparent }
              )
            )
            yield* promiseEffect(() =>
              composition.services.delivery.markEnqueued(outboxId, new Date().toISOString())
            )
          })
        )
      )
    }
    const nextDue = await reminders.nextDue(composition.config.OWNER_ID)
    if (nextDue === undefined) await this.state.storage.deleteAlarm()
    else await this.state.storage.setAlarm(new Date(nextDue))
    return outboxIds.length
  }
}
