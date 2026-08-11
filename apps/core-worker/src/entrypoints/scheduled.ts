import type { CoreBindings } from "../bindings.ts"
import { composeCore } from "../composition.ts"
import { and, eq, isNull } from "drizzle-orm"
import { outboxMessages } from "../modules/delivery/schema.ts"
import { schedulerOutbox } from "../modules/reminders/schema.ts"

export async function handleScheduled(bindings: CoreBindings): Promise<void> {
  const composition = composeCore(bindings)
  const startedAt = new Date().toISOString()
  await composition.services.delivery.reconcileExpiredClaims(startedAt)
  await composition.services.reminders.releaseExpiredClaims(startedAt)
  await composition.services.reminders.markExpiredResponseDeadlines(startedAt)
  const euClock = bindings.REMINDER_CLOCK.jurisdiction("eu")
  const clock = euClock.get(euClock.idFromName(composition.config.OWNER_ID))

  const pendingScheduler = await composition.database
    .select()
    .from(schedulerOutbox)
    .where(isNull(schedulerOutbox.processedAt))
    .orderBy(schedulerOutbox.createdAt)
    .limit(100)
  for (const item of pendingScheduler) {
    const response = await clock.fetch("https://clock.internal/command", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: item.id,
        reminderId: item.reminderId,
        scheduleRevision: item.scheduleRevision,
        command: item.command
      })
    })
    if (!response.ok) throw new Error("reminder_clock_command_failed")
    await composition.database
      .update(schedulerOutbox)
      .set({ processedAt: new Date().toISOString() })
      .where(and(eq(schedulerOutbox.id, item.id), isNull(schedulerOutbox.processedAt)))
  }

  const clockResponse = await clock.fetch("https://clock.internal/reconcile", { method: "POST" })
  if (!clockResponse.ok) throw new Error("reminder_clock_reconcile_failed")

  const pendingOutbox = await composition.database
    .select({ id: outboxMessages.id })
    .from(outboxMessages)
    .where(and(eq(outboxMessages.state, "pending"), isNull(outboxMessages.enqueuedAt)))
    .limit(100)
  for (const item of pendingOutbox) {
    await bindings.OUTBOUND_QUEUE.send({ outboxId: item.id })
    await composition.services.delivery.markEnqueued(item.id, new Date().toISOString())
  }
}
