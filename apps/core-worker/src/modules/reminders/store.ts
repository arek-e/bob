import type { ReminderCreateArguments } from "@bob/contracts/tools"
import { and, asc, eq, gt, gte, inArray, isNull, lt, lte, or, sql } from "drizzle-orm"
import type { BatchItem } from "drizzle-orm/batch"
import { Context, Layer } from "effect"

import type { CoreDatabase } from "../../database.ts"
import { operationalAlerts } from "../alerts/schema.ts"
import { channels, messages, shortReplyBindings, users } from "../conversations/schema.ts"
import { outboxMessages } from "../delivery/schema.ts"
import type { DataProtection } from "../policy/data-protection.ts"
import {
  localDisplay,
  localDayBounds,
  nextDailyWindow,
  nextRecurringDueAt,
  occurrenceIdempotencyKey,
  deferForQuietHours,
  type QuietHours,
  resolveLocalDueAt,
  transitionOccurrence
} from "./rules.ts"
import { reminderActions, reminderOccurrences, reminders, schedulerOutbox } from "./schema.ts"

export interface ReminderSummary {
  readonly id: string
  readonly displayText: string
  readonly nextDueAt?: string
  readonly localDisplayTime?: string
  readonly state: string
}

export interface ReminderCreateResult {
  readonly reminderId: string
  readonly occurrenceId: string
  readonly dueAt: string
  readonly localDisplayTime: string
  readonly duplicate: boolean
}

export interface ReminderStore {
  createOneShot(
    ownerId: string,
    channelId: string,
    originalWording: string,
    input: ReminderCreateArguments,
    idempotencyKey: string
  ): Promise<ReminderCreateResult>
  list(ownerId: string): Promise<readonly ReminderSummary[]>
  acknowledge(occurrenceId: string, idempotencyKey: string): Promise<void>
  complete(occurrenceId: string, idempotencyKey: string): Promise<void>
  applyBoundReply(
    ownerId: string,
    bindingId: string,
    command: "seen" | "done"
  ): Promise<"applied" | "invalid">
  snooze(occurrenceId: string, dueAt: string, idempotencyKey: string): Promise<string>
  cancel(
    reminderId: string,
    occurrenceId: string | undefined,
    idempotencyKey: string
  ): Promise<void>
  releaseExpiredClaims(at: string): Promise<number>
  markExpiredResponseDeadlines(at: string): Promise<number>
  claimDueAndCreateOutbox(ownerId: string, leaseMs: number): Promise<readonly string[]>
  nextDue(ownerId: string): Promise<string | undefined>
}

export const ReminderStore = Context.Service<ReminderStore>("bob/ReminderStore")

export function makeReminderStore(
  database: CoreDatabase,
  protection: DataProtection,
  options: {
    readonly now?: () => Date
    readonly randomUuid?: () => string
    readonly quietHours?: QuietHours
    readonly dailyLimit?: number
  }
): ReminderStore {
  const now = options.now ?? (() => new Date())
  const randomUuid = options.randomUuid ?? (() => crypto.randomUUID())
  const quietHours = options.quietHours
  const dailyLimit = options.dailyLimit

  async function ownerKey(ownerId: string): Promise<{ key: CryptoKey; version: number }> {
    const [owner] = await database.select().from(users).where(eq(users.id, ownerId)).limit(1)
    if (
      owner?.wrappedDataKey === null ||
      owner?.wrappedDataKey === undefined ||
      owner.wrappedDataKeyIv === null ||
      owner.wrappedDataKeyIv === undefined ||
      owner.dataKeyVersion === null ||
      owner.dataKeyVersion === undefined
    ) {
      throw new Error("Owner data key is unavailable")
    }
    return {
      key: await protection.unwrapDataKey({
        ciphertext: owner.wrappedDataKey,
        iv: owner.wrappedDataKeyIv,
        version: owner.dataKeyVersion
      }),
      version: owner.dataKeyVersion
    }
  }

  async function actionExists(idempotencyKey: string): Promise<boolean> {
    const [action] = await database
      .select({ id: reminderActions.id })
      .from(reminderActions)
      .where(eq(reminderActions.idempotencyKey, idempotencyKey))
      .limit(1)
    return action !== undefined
  }

  return {
    async createOneShot(ownerId, channelId, originalWording, input, idempotencyKey) {
      const [existingAction] = await database
        .select({
          reminderId: reminderActions.reminderId,
          occurrenceId: reminderActions.occurrenceId
        })
        .from(reminderActions)
        .where(eq(reminderActions.idempotencyKey, idempotencyKey))
        .limit(1)
      if (existingAction?.occurrenceId !== null && existingAction?.occurrenceId !== undefined) {
        const [occurrence] = await database
          .select()
          .from(reminderOccurrences)
          .where(eq(reminderOccurrences.id, existingAction.occurrenceId))
          .limit(1)
        if (occurrence === undefined) throw new Error("Idempotent reminder occurrence is missing")
        return {
          reminderId: existingAction.reminderId,
          occurrenceId: occurrence.id,
          dueAt: occurrence.intendedDueAt,
          localDisplayTime: occurrence.localDisplayTime,
          duplicate: true
        }
      }

      const dueAt = resolveLocalDueAt(input.localDate, input.localTime, input.timeZone)
      if (Math.abs(Date.parse(dueAt) - Date.parse(input.dueAt)) > 1_000) {
        throw new Error("Reminder due time does not match its local date and time")
      }
      const owner = await ownerKey(ownerId)
      const [original, display, sms] = await Promise.all([
        protection.encryptText(owner.key, originalWording),
        protection.encryptText(owner.key, input.displayText),
        protection.encryptText(owner.key, input.smsSafeText)
      ])
      const reminderId = randomUuid()
      const occurrenceId = randomUuid()
      const createdAt = now().toISOString()
      const displayTime = localDisplay(dueAt, input.timeZone)
      await database.batch([
        database.insert(reminders).values({
          id: reminderId,
          userId: ownerId,
          sourceMessageId: input.sourceMessageId,
          originalWordingCiphertext: original.ciphertext,
          originalWordingIv: original.iv,
          displayTextCiphertext: display.ciphertext,
          displayTextIv: display.iv,
          smsSafeTextCiphertext: sms.ciphertext,
          smsSafeTextIv: sms.iv,
          dataKeyVersion: owner.version,
          sensitivity: "normal",
          scheduleKind: "one_shot",
          localStartDate: input.localDate,
          localStartTime: input.localTime,
          timeZone: input.timeZone,
          nextDueAt: dueAt,
          quietHoursBehavior: "defer",
          requiresAcknowledgment: input.requiresAcknowledgment,
          responseDeadlineMinutes: 1_440,
          repeatPolicy: "none",
          maxAttempts: 1,
          channelId,
          state: "active",
          scheduleRevision: 1,
          createdAt,
          updatedAt: createdAt
        }),
        database.insert(reminderOccurrences).values({
          id: occurrenceId,
          reminderId,
          sequence: 1,
          intendedDueAt: dueAt,
          localDisplayTime: displayTime,
          idempotencyKey: occurrenceIdempotencyKey(reminderId, dueAt, 1),
          state: "scheduled",
          createdAt,
          updatedAt: createdAt
        }),
        database.insert(reminderActions).values({
          id: randomUuid(),
          reminderId,
          occurrenceId,
          action: "created",
          actor: "owner",
          idempotencyKey,
          createdAt
        }),
        database.insert(schedulerOutbox).values({
          id: randomUuid(),
          userId: ownerId,
          reminderId,
          scheduleRevision: 1,
          command: "upsert",
          createdAt
        })
      ])
      return { reminderId, occurrenceId, dueAt, localDisplayTime: displayTime, duplicate: false }
    },

    async list(ownerId) {
      const rows = await database
        .select()
        .from(reminders)
        .where(and(eq(reminders.userId, ownerId), inArray(reminders.state, ["active", "paused"])))
        .orderBy(asc(reminders.nextDueAt))
      const key = (await ownerKey(ownerId)).key
      return Promise.all(
        rows.map(async (row) => ({
          id: row.id,
          displayText: await protection.decryptText(key, {
            ciphertext: row.displayTextCiphertext,
            iv: row.displayTextIv
          }),
          ...(row.nextDueAt === null ? {} : { nextDueAt: row.nextDueAt }),
          ...(row.nextDueAt === null
            ? {}
            : { localDisplayTime: localDisplay(row.nextDueAt, row.timeZone) }),
          state: row.state
        }))
      )
    },

    async acknowledge(occurrenceId, idempotencyKey) {
      if (await actionExists(idempotencyKey)) return
      const [occurrence] = await database
        .select()
        .from(reminderOccurrences)
        .where(eq(reminderOccurrences.id, occurrenceId))
        .limit(1)
      if (occurrence === undefined) throw new Error("Reminder occurrence not found")
      transitionOccurrence(occurrence.state, "acknowledged")
      const at = now().toISOString()
      await database.batch([
        database
          .update(reminderOccurrences)
          .set({ state: "acknowledged", updatedAt: at })
          .where(
            and(
              eq(reminderOccurrences.id, occurrenceId),
              eq(reminderOccurrences.state, occurrence.state)
            )
          ),
        database.insert(reminderActions).values({
          id: randomUuid(),
          reminderId: occurrence.reminderId,
          occurrenceId,
          action: "acknowledged",
          actor: "owner",
          idempotencyKey,
          createdAt: at
        }),
        database
          .update(shortReplyBindings)
          .set({ consumedAt: at })
          .where(
            and(
              eq(shortReplyBindings.targetType, "reminder"),
              eq(shortReplyBindings.targetId, occurrenceId),
              eq(shortReplyBindings.command, "seen"),
              isNull(shortReplyBindings.consumedAt)
            )
          )
      ])
    },

    async complete(occurrenceId, idempotencyKey) {
      if (await actionExists(idempotencyKey)) return
      const [occurrence] = await database
        .select()
        .from(reminderOccurrences)
        .where(eq(reminderOccurrences.id, occurrenceId))
        .limit(1)
      if (occurrence === undefined) throw new Error("Reminder occurrence not found")
      transitionOccurrence(occurrence.state, "completed")
      const at = now().toISOString()
      await database.batch([
        database
          .update(reminderOccurrences)
          .set({ state: "completed", updatedAt: at })
          .where(
            and(
              eq(reminderOccurrences.id, occurrenceId),
              eq(reminderOccurrences.state, occurrence.state)
            )
          ),
        database.insert(reminderActions).values({
          id: randomUuid(),
          reminderId: occurrence.reminderId,
          occurrenceId,
          action: "completed",
          actor: "owner",
          idempotencyKey,
          createdAt: at
        }),
        database
          .update(shortReplyBindings)
          .set({ consumedAt: at })
          .where(
            and(
              eq(shortReplyBindings.targetType, "reminder"),
              eq(shortReplyBindings.targetId, occurrenceId),
              isNull(shortReplyBindings.consumedAt)
            )
          )
      ])
    },

    async applyBoundReply(ownerId, bindingId, command) {
      const at = now().toISOString()
      const idempotencyKey = `reply:${bindingId}:${command}`
      if (await actionExists(idempotencyKey)) return "applied"
      const [binding] = await database
        .select()
        .from(shortReplyBindings)
        .where(
          and(
            eq(shortReplyBindings.id, bindingId),
            eq(shortReplyBindings.userId, ownerId),
            eq(shortReplyBindings.command, command),
            eq(shortReplyBindings.targetType, "reminder"),
            isNull(shortReplyBindings.consumedAt),
            gt(shortReplyBindings.expiresAt, at)
          )
        )
        .limit(1)
      if (binding === undefined) return "invalid"
      const [occurrence] = await database
        .select()
        .from(reminderOccurrences)
        .where(eq(reminderOccurrences.id, binding.targetId))
        .limit(1)
      if (occurrence === undefined) return "invalid"
      const next = command === "seen" ? "acknowledged" : "completed"
      transitionOccurrence(occurrence.state, next)
      try {
        await database.batch([
          database
            .update(shortReplyBindings)
            .set({ consumedAt: at })
            .where(
              and(
                eq(shortReplyBindings.id, binding.id),
                isNull(shortReplyBindings.consumedAt),
                gt(shortReplyBindings.expiresAt, at)
              )
            ),
          database
            .update(reminderOccurrences)
            .set({ state: next, updatedAt: at })
            .where(
              and(
                eq(reminderOccurrences.id, occurrence.id),
                eq(reminderOccurrences.state, occurrence.state)
              )
            ),
          database.insert(reminderActions).values({
            id: randomUuid(),
            reminderId: occurrence.reminderId,
            occurrenceId: occurrence.id,
            action: next,
            actor: "owner",
            idempotencyKey,
            createdAt: at
          }),
          ...(next === "completed"
            ? [
                database
                  .update(shortReplyBindings)
                  .set({ consumedAt: at })
                  .where(
                    and(
                      eq(shortReplyBindings.targetType, "reminder"),
                      eq(shortReplyBindings.targetId, occurrence.id),
                      isNull(shortReplyBindings.consumedAt)
                    )
                  )
              ]
            : [])
        ])
      } catch {
        return (await actionExists(idempotencyKey)) ? "applied" : "invalid"
      }
      return "applied"
    },

    async snooze(occurrenceId, dueAt, idempotencyKey) {
      const [existing] = await database
        .select({ occurrenceId: reminderActions.occurrenceId })
        .from(reminderActions)
        .where(eq(reminderActions.idempotencyKey, idempotencyKey))
        .limit(1)
      if (existing?.occurrenceId !== null && existing?.occurrenceId !== undefined)
        return existing.occurrenceId
      const [occurrence] = await database
        .select()
        .from(reminderOccurrences)
        .where(eq(reminderOccurrences.id, occurrenceId))
        .limit(1)
      if (occurrence === undefined) throw new Error("Reminder occurrence not found")
      transitionOccurrence(occurrence.state, "snoozed")
      const [reminder] = await database
        .select()
        .from(reminders)
        .where(eq(reminders.id, occurrence.reminderId))
        .limit(1)
      if (reminder === undefined) throw new Error("Reminder not found")
      const successorId = randomUuid()
      const revision = reminder.scheduleRevision + 1
      const createdAt = now().toISOString()
      await database.batch([
        database
          .update(reminderOccurrences)
          .set({ state: "snoozed", snoozedToOccurrenceId: successorId, updatedAt: createdAt })
          .where(
            and(
              eq(reminderOccurrences.id, occurrenceId),
              eq(reminderOccurrences.state, occurrence.state)
            )
          ),
        database.insert(reminderOccurrences).values({
          id: successorId,
          reminderId: reminder.id,
          sequence: occurrence.sequence + 1,
          intendedDueAt: dueAt,
          localDisplayTime: localDisplay(dueAt, reminder.timeZone),
          idempotencyKey: occurrenceIdempotencyKey(reminder.id, dueAt, occurrence.sequence + 1),
          state: "scheduled",
          createdAt,
          updatedAt: createdAt
        }),
        database
          .update(reminders)
          .set({ nextDueAt: dueAt, scheduleRevision: revision, updatedAt: createdAt })
          .where(eq(reminders.id, reminder.id)),
        database.insert(reminderActions).values({
          id: randomUuid(),
          reminderId: reminder.id,
          occurrenceId: successorId,
          action: "snoozed",
          actor: "owner",
          idempotencyKey,
          createdAt
        }),
        database
          .update(shortReplyBindings)
          .set({ consumedAt: createdAt })
          .where(
            and(
              eq(shortReplyBindings.targetType, "reminder"),
              eq(shortReplyBindings.targetId, occurrenceId),
              isNull(shortReplyBindings.consumedAt)
            )
          ),
        database.insert(schedulerOutbox).values({
          id: randomUuid(),
          userId: reminder.userId,
          reminderId: reminder.id,
          scheduleRevision: revision,
          command: "upsert",
          createdAt
        })
      ])
      return successorId
    },

    async cancel(reminderId, occurrenceId, idempotencyKey) {
      if (await actionExists(idempotencyKey)) return
      const at = now().toISOString()
      const [reminder] = await database
        .select()
        .from(reminders)
        .where(eq(reminders.id, reminderId))
        .limit(1)
      if (reminder === undefined) throw new Error("Reminder not found")
      if (occurrenceId !== undefined) {
        await database.batch([
          database
            .update(reminderOccurrences)
            .set({ state: "cancelled", updatedAt: at })
            .where(eq(reminderOccurrences.id, occurrenceId)),
          database.insert(reminderActions).values({
            id: randomUuid(),
            reminderId,
            occurrenceId,
            action: "cancelled",
            actor: "owner",
            idempotencyKey,
            createdAt: at
          }),
          database
            .update(shortReplyBindings)
            .set({ consumedAt: at })
            .where(
              and(
                eq(shortReplyBindings.targetType, "reminder"),
                eq(shortReplyBindings.targetId, occurrenceId),
                isNull(shortReplyBindings.consumedAt)
              )
            )
        ])
        return
      }
      const revision = reminder.scheduleRevision + 1
      const activeOccurrences = await database
        .select({ id: reminderOccurrences.id })
        .from(reminderOccurrences)
        .where(eq(reminderOccurrences.reminderId, reminderId))
      const statements: [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]] = [
        database
          .update(reminders)
          .set({ state: "cancelled", nextDueAt: null, scheduleRevision: revision, updatedAt: at })
          .where(eq(reminders.id, reminderId)),
        database
          .update(reminderOccurrences)
          .set({ state: "cancelled", updatedAt: at })
          .where(
            and(
              eq(reminderOccurrences.reminderId, reminderId),
              inArray(reminderOccurrences.state, [
                "scheduled",
                "claimed",
                "awaiting_delivery",
                "awaiting_response",
                "acknowledged"
              ])
            )
          ),
        database.insert(reminderActions).values({
          id: randomUuid(),
          reminderId,
          action: "cancelled",
          actor: "owner",
          idempotencyKey,
          createdAt: at
        }),
        database.insert(schedulerOutbox).values({
          id: randomUuid(),
          userId: reminder.userId,
          reminderId,
          scheduleRevision: revision,
          command: "remove",
          createdAt: at
        })
      ]
      for (const occurrence of activeOccurrences) {
        statements.push(
          database
            .update(shortReplyBindings)
            .set({ consumedAt: at })
            .where(
              and(
                eq(shortReplyBindings.targetType, "reminder"),
                eq(shortReplyBindings.targetId, occurrence.id),
                isNull(shortReplyBindings.consumedAt)
              )
            )
        )
      }
      await database.batch(statements)
    },

    async releaseExpiredClaims(at) {
      const released = await database
        .update(reminderOccurrences)
        .set({
          state: "scheduled",
          claimToken: null,
          claimedAt: null,
          claimExpiresAt: null,
          updatedAt: at
        })
        .where(
          and(eq(reminderOccurrences.state, "claimed"), lt(reminderOccurrences.claimExpiresAt, at))
        )
        .returning({ id: reminderOccurrences.id })
      return released.length
    },

    async markExpiredResponseDeadlines(at) {
      const expired = await database
        .select({ occurrence: reminderOccurrences, ownerId: reminders.userId })
        .from(reminderOccurrences)
        .innerJoin(reminders, eq(reminderOccurrences.reminderId, reminders.id))
        .where(
          and(
            inArray(reminderOccurrences.state, ["awaiting_delivery", "awaiting_response"]),
            lte(reminderOccurrences.responseDeadlineAt, at)
          )
        )
        .limit(100)
      for (const row of expired) {
        await database.batch([
          database
            .update(reminderOccurrences)
            .set({ state: "missed", updatedAt: at })
            .where(
              and(
                eq(reminderOccurrences.id, row.occurrence.id),
                inArray(reminderOccurrences.state, ["awaiting_delivery", "awaiting_response"]),
                lte(reminderOccurrences.responseDeadlineAt, at)
              )
            ),
          database
            .update(shortReplyBindings)
            .set({ consumedAt: at })
            .where(
              and(
                eq(shortReplyBindings.targetType, "reminder"),
                eq(shortReplyBindings.targetId, row.occurrence.id),
                isNull(shortReplyBindings.consumedAt)
              )
            ),
          database
            .insert(operationalAlerts)
            .values({
              id: randomUuid(),
              userId: row.ownerId,
              code: "reminder_missed",
              objectType: "reminder_occurrence",
              objectId: row.occurrence.id,
              idempotencyKey: `alert:reminder-missed:${row.occurrence.id}`,
              state: "open",
              createdAt: at,
              updatedAt: at
            })
            .onConflictDoNothing()
        ])
      }
      return expired.length
    },

    async claimDueAndCreateOutbox(ownerId, leaseMs) {
      const timestamp = now()
      const timestampIso = timestamp.toISOString()
      let sentToday = 0
      if (dailyLimit !== undefined && quietHours !== undefined) {
        const bounds = localDayBounds(timestampIso, quietHours.timeZone)
        const [count] = await database
          .select({ count: sql<number>`count(*)` })
          .from(outboxMessages)
          .where(
            and(
              eq(outboxMessages.userId, ownerId),
              eq(outboxMessages.reasonCode, "reminder_due"),
              gte(outboxMessages.createdAt, bounds.start),
              lt(outboxMessages.createdAt, bounds.end)
            )
          )
        sentToday = Number(count?.count ?? 0)
      }
      const due = await database
        .select({ occurrence: reminderOccurrences, reminder: reminders })
        .from(reminderOccurrences)
        .innerJoin(reminders, eq(reminderOccurrences.reminderId, reminders.id))
        .where(
          and(
            eq(reminders.userId, ownerId),
            eq(reminders.state, "active"),
            lte(reminderOccurrences.intendedDueAt, timestamp.toISOString()),
            or(
              eq(reminderOccurrences.state, "scheduled"),
              and(
                eq(reminderOccurrences.state, "claimed"),
                lt(reminderOccurrences.claimExpiresAt, timestamp.toISOString())
              )
            )
          )
        )
        .limit(25)
      const outboxIds: string[] = []
      for (const row of due) {
        const quietDeferredAt =
          quietHours === undefined || row.reminder.quietHoursBehavior === "allow"
            ? timestampIso
            : deferForQuietHours(timestampIso, quietHours)
        const limited = dailyLimit !== undefined && sentToday >= dailyLimit
        if (quietDeferredAt !== timestampIso || limited) {
          const deferredAt = limited ? nextDailyWindow(timestampIso, quietHours!) : quietDeferredAt
          await database.batch([
            database
              .update(reminderOccurrences)
              .set({
                intendedDueAt: deferredAt,
                localDisplayTime: localDisplay(deferredAt, row.reminder.timeZone),
                updatedAt: timestampIso
              })
              .where(
                and(
                  eq(reminderOccurrences.id, row.occurrence.id),
                  eq(reminderOccurrences.state, "scheduled")
                )
              ),
            database
              .update(reminders)
              .set({ nextDueAt: deferredAt, updatedAt: timestampIso })
              .where(eq(reminders.id, row.reminder.id))
          ])
          continue
        }
        const claimToken = randomUuid()
        const [claimed] = await database
          .update(reminderOccurrences)
          .set({
            state: "claimed",
            claimToken,
            claimedAt: timestamp.toISOString(),
            claimExpiresAt: new Date(timestamp.getTime() + leaseMs).toISOString(),
            updatedAt: timestamp.toISOString()
          })
          .where(
            and(
              eq(reminderOccurrences.id, row.occurrence.id),
              or(
                eq(reminderOccurrences.state, "scheduled"),
                and(
                  eq(reminderOccurrences.state, "claimed"),
                  lt(reminderOccurrences.claimExpiresAt, timestamp.toISOString())
                )
              )
            )
          )
          .returning()
        if (claimed === undefined) continue

        const messageId = randomUuid()
        const outboxId = randomUuid()
        const correlationId = randomUuid()
        const responseDeadlineAt = new Date(
          Date.parse(claimed.intendedDueAt) + row.reminder.responseDeadlineMinutes * 60_000
        ).toISOString()
        const statements = [
          database.insert(messages).values({
            id: messageId,
            userId: ownerId,
            channelId: row.reminder.channelId,
            direction: "outbound" as const,
            textCiphertext: row.reminder.smsSafeTextCiphertext,
            textIv: row.reminder.smsSafeTextIv,
            dataKeyVersion: row.reminder.dataKeyVersion,
            occurredAt: timestamp.toISOString(),
            createdAt: timestamp.toISOString()
          }),
          database.insert(outboxMessages).values({
            id: outboxId,
            userId: ownerId,
            channelId: row.reminder.channelId,
            messageId,
            reasonCode: "reminder_due",
            correlationId,
            idempotencyKey: `reminder:${claimed.id}:delivery`,
            actionTargetType: "reminder_occurrence",
            actionTargetId: claimed.id,
            state: "pending" as const,
            createdAt: timestamp.toISOString()
          }),
          database
            .update(reminderOccurrences)
            .set({
              state: "awaiting_delivery" as const,
              responseDeadlineAt,
              updatedAt: timestamp.toISOString()
            })
            .where(
              and(
                eq(reminderOccurrences.id, claimed.id),
                eq(reminderOccurrences.claimToken, claimToken),
                eq(reminderOccurrences.state, "claimed")
              )
            )
        ] as const

        if (row.reminder.scheduleKind === "recurring" && row.reminder.rrule !== null) {
          const nextDueAt = nextRecurringDueAt(
            claimed.intendedDueAt,
            row.reminder.rrule,
            row.reminder.timeZone
          )
          const nextOccurrenceId = randomUuid()
          await database.batch([
            ...statements,
            database.insert(reminderOccurrences).values({
              id: nextOccurrenceId,
              reminderId: row.reminder.id,
              sequence: claimed.sequence + 1,
              intendedDueAt: nextDueAt,
              localDisplayTime: localDisplay(nextDueAt, row.reminder.timeZone),
              idempotencyKey: occurrenceIdempotencyKey(
                row.reminder.id,
                nextDueAt,
                claimed.sequence + 1
              ),
              state: "scheduled",
              createdAt: timestamp.toISOString(),
              updatedAt: timestamp.toISOString()
            }),
            database
              .update(reminders)
              .set({ nextDueAt, updatedAt: timestamp.toISOString() })
              .where(eq(reminders.id, row.reminder.id))
          ])
        } else {
          await database.batch([
            ...statements,
            database
              .update(reminders)
              .set({ nextDueAt: null, updatedAt: timestamp.toISOString() })
              .where(eq(reminders.id, row.reminder.id))
          ])
        }
        outboxIds.push(outboxId)
        sentToday += 1
      }
      return outboxIds
    },

    async nextDue(ownerId) {
      const [next] = await database
        .select({ dueAt: reminderOccurrences.intendedDueAt })
        .from(reminderOccurrences)
        .innerJoin(reminders, eq(reminderOccurrences.reminderId, reminders.id))
        .where(
          and(
            eq(reminders.userId, ownerId),
            eq(reminders.state, "active"),
            eq(reminderOccurrences.state, "scheduled")
          )
        )
        .orderBy(asc(reminderOccurrences.intendedDueAt))
        .limit(1)
      return next?.dueAt
    }
  }
}

export function reminderStoreLayer(store: ReminderStore) {
  return Layer.succeed(ReminderStore, store)
}
