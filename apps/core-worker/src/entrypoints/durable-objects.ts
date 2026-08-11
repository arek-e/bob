import { InboundJob } from "@bob/contracts/jobs"
import { Schema } from "effect"

import type { CoreBindings } from "../bindings.ts"
import { composeCore } from "../composition.ts"
import { processInbound } from "../process-inbound.ts"

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
      await this.state.blockConcurrencyWhile(() =>
        processInbound(job.eventId, this.bindings, composeCore(this.bindings))
      )
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
          return Response.json({ ok: true, duplicate: true })
        }
        const count = await this.runClock()
        await this.state.storage.put(versionKey, command.scheduleRevision)
        return Response.json({ ok: true, duplicate: false, dueCount: count })
      }
      const count = await this.runClock()
      return Response.json({ ok: true, dueCount: count })
    } catch {
      return Response.json({ code: "clock_failed" }, { status: 503 })
    }
  }

  async alarm(): Promise<void> {
    await this.runClock()
  }

  private async runClock(): Promise<number> {
    const composition = composeCore(this.bindings)
    const outboxIds = await composition.services.reminders.claimDueAndCreateOutbox(
      composition.config.OWNER_ID,
      60_000
    )
    for (const outboxId of outboxIds) {
      await this.bindings.OUTBOUND_QUEUE.send({ outboxId })
      await composition.services.delivery.markEnqueued(outboxId, new Date().toISOString())
    }
    const nextDue = await composition.services.reminders.nextDue(composition.config.OWNER_ID)
    if (nextDue === undefined) await this.state.storage.deleteAlarm()
    else await this.state.storage.setAlarm(new Date(nextDue))
    return outboxIds.length
  }
}
