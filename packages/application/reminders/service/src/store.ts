import type { CoreDatabase, DatabaseQuery } from "@bob/db-types"
import type { DataProtection } from "@bob/policy-types/data-protection"
import type { OwnerDataKeyStoreAdapter } from "@bob/policy-types/owner-data-key"
import type { ReminderCreateArguments } from "@bob/reminders-types/capability"

import { operationalAlerts } from "@bob/db-service/schema/alerts"
import { messages, shortReplyBindings, users } from "@bob/db-service/schema/conversations"
import { outboxMessages } from "@bob/db-service/schema/delivery"
import {
  reminderActions,
  reminderOccurrences,
  reminders,
  schedulerOutbox
} from "@bob/db-service/schema/reminders"
import { allInTransaction } from "@bob/db-types"
import { makeOwnerDataKeyStore } from "@bob/policy-service/owner-data-key"
import { and, asc, eq, gt, gte, inArray, isNull, lt, lte, or, sql, type SQL } from "drizzle-orm"
import { Effect, Context, Layer } from "effect"

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

const ONE_SHOT_REMINDER_POLICY = {
  requiresAcknowledgment: true,
  responseDeadlineMinutes: 1_440,
  repeatPolicy: "none",
  maxAttempts: 1
} as const

export interface ReminderSummary {
  readonly id: string
  readonly displayText: string
  readonly nextDueAt?: string
  readonly localDisplayTime?: string
  readonly timeZone: string
  readonly state: string
  readonly actionTargets: readonly ReminderActionTarget[]
}

export interface ReminderActionTarget {
  readonly occurrenceId: string
  readonly dueAt: string
  readonly localDisplayTime: string
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
  acknowledge(ownerId: string, occurrenceId: string, idempotencyKey: string): Promise<void>
  complete(ownerId: string, occurrenceId: string, idempotencyKey: string): Promise<void>
  applyBoundReply(
    ownerId: string,
    bindingId: string,
    command: "seen" | "done"
  ): Promise<"applied" | "invalid">
  snooze(
    ownerId: string,
    occurrenceId: string,
    dueAt: string,
    idempotencyKey: string
  ): Promise<string>
  cancel(
    ownerId: string,
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
    readonly ownerDataKeys?: OwnerDataKeyStoreAdapter
  }
): ReminderStore {
  const now = options.now ?? (() => new Date())
  const randomUuid = options.randomUuid ?? (() => crypto.randomUUID())
  const quietHours = options.quietHours
  const dailyLimit = options.dailyLimit
  const ownerDataKeys =
    options.ownerDataKeys ??
    makeOwnerDataKeyStore(database, protection, { defaultTimeZone: "UTC", now })

  async function ownerQuietHours(ownerId: string): Promise<QuietHours | undefined> {
    if (quietHours === undefined) return undefined
    const [owner] = await Effect.runPromise(
      database
        .select({ timeZone: users.timeZone })
        .from(users)
        .where(eq(users.id, ownerId))
        .limit(1)
    )
    return { ...quietHours, timeZone: owner?.timeZone ?? quietHours.timeZone }
  }

  async function actionExists(idempotencyKey: string): Promise<boolean> {
    const [action] = await Effect.runPromise(
      database
        .select({ id: reminderActions.id })
        .from(reminderActions)
        .where(eq(reminderActions.idempotencyKey, idempotencyKey))
        .limit(1)
    )
    return action !== undefined
  }

  async function actionWasRecorded(actionId: string): Promise<boolean> {
    const [action] = await Effect.runPromise(
      database
        .select({ id: reminderActions.id })
        .from(reminderActions)
        .where(eq(reminderActions.id, actionId))
        .limit(1)
    )
    return action !== undefined
  }

  function actionRecorded(actionId: string) {
    return sql<boolean>`exists (
      select 1 from ${reminderActions}
      where ${reminderActions.id} = ${actionId}
    )`
  }

  function conditionalOccurrenceAction(input: {
    readonly id: string
    readonly ownerId: string
    readonly reminderId: string
    readonly sourceOccurrenceId: string
    readonly expectedState: typeof reminderOccurrences.$inferSelect.state
    readonly actionOccurrenceId: string
    readonly action: "acknowledged" | "completed" | "snoozed" | "cancelled"
    readonly idempotencyKey: string
    readonly createdAt: string
    readonly extraCondition?: SQL
  }): DatabaseQuery {
    return database.insert(reminderActions).select(
      database
        .select({
          id: sql<string>`${input.id}`.as("id"),
          reminderId: sql<string>`${input.reminderId}`.as("reminder_id"),
          occurrenceId: sql<string>`${input.actionOccurrenceId}`.as("occurrence_id"),
          action: sql<typeof input.action>`${input.action}`.as("action"),
          actor: sql<"owner">`'owner'`.as("actor"),
          idempotencyKey: sql<string>`${input.idempotencyKey}`.as("idempotency_key"),
          createdAt: sql<string>`${input.createdAt}`.as("created_at")
        })
        .from(reminderOccurrences)
        .innerJoin(reminders, eq(reminderOccurrences.reminderId, reminders.id))
        .where(
          and(
            eq(reminderOccurrences.id, input.sourceOccurrenceId),
            eq(reminderOccurrences.reminderId, input.reminderId),
            eq(reminderOccurrences.state, input.expectedState),
            eq(reminders.userId, input.ownerId),
            input.extraCondition ?? sql<boolean>`true`
          )
        )
    )
  }

  function conditionalScheduledOccurrence(input: {
    readonly actionId: string
    readonly id: string
    readonly reminderId: string
    readonly sequence: number
    readonly dueAt: string
    readonly localDisplayTime: string
    readonly idempotencyKey: string
    readonly createdAt: string
  }): DatabaseQuery {
    return database.insert(reminderOccurrences).select(
      database
        .select({
          id: sql<string>`${input.id}`.as("id"),
          reminderId: sql<string>`${input.reminderId}`.as("reminder_id"),
          sequence: sql<number>`${input.sequence}`.as("sequence"),
          intendedDueAt: sql<string>`${input.dueAt}`.as("intended_due_at"),
          localDisplayTime: sql<string>`${input.localDisplayTime}`.as("local_display_time"),
          idempotencyKey: sql<string>`${input.idempotencyKey}`.as("idempotency_key"),
          state: sql<"scheduled">`'scheduled'`.as("state"),
          createdAt: sql<string>`${input.createdAt}`.as("created_at"),
          updatedAt: sql<string>`${input.createdAt}`.as("updated_at")
        })
        .from(reminderActions)
        .where(eq(reminderActions.id, input.actionId))
    )
  }

  function conditionalSchedulerCommand(input: {
    readonly actionId: string
    readonly id: string
    readonly ownerId: string
    readonly reminderId: string
    readonly scheduleRevision: number
    readonly command: "upsert" | "remove"
    readonly createdAt: string
  }): DatabaseQuery {
    return database.insert(schedulerOutbox).select(
      database
        .select({
          id: sql<string>`${input.id}`.as("id"),
          userId: sql<string>`${input.ownerId}`.as("user_id"),
          reminderId: sql<string>`${input.reminderId}`.as("reminder_id"),
          scheduleRevision: sql<number>`${input.scheduleRevision}`.as("schedule_revision"),
          command: sql<typeof input.command>`${input.command}`.as("command"),
          createdAt: sql<string>`${input.createdAt}`.as("created_at")
        })
        .from(reminderActions)
        .where(eq(reminderActions.id, input.actionId))
    )
  }

  async function ownedOccurrence(ownerId: string, occurrenceId: string) {
    const [row] = await Effect.runPromise(
      database
        .select({ occurrence: reminderOccurrences })
        .from(reminderOccurrences)
        .innerJoin(reminders, eq(reminderOccurrences.reminderId, reminders.id))
        .where(and(eq(reminderOccurrences.id, occurrenceId), eq(reminders.userId, ownerId)))
        .limit(1)
    )
    return row?.occurrence
  }

  return {
    async createOneShot(ownerId, channelId, originalWording, input, idempotencyKey) {
      const [existingAction] = await Effect.runPromise(
        database
          .select({
            reminderId: reminderActions.reminderId,
            occurrenceId: reminderActions.occurrenceId
          })
          .from(reminderActions)
          .where(eq(reminderActions.idempotencyKey, idempotencyKey))
          .limit(1)
      )
      if (existingAction?.occurrenceId !== null && existingAction?.occurrenceId !== undefined) {
        const [occurrence] = await Effect.runPromise(
          database
            .select()
            .from(reminderOccurrences)
            .where(eq(reminderOccurrences.id, existingAction.occurrenceId))
            .limit(1)
        )
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
      if (Date.parse(dueAt) !== Date.parse(input.dueAt)) {
        throw new Error("Reminder due time does not match its local date and time")
      }
      const owner = await ownerDataKeys.load(ownerId)
      const [original, display, sms] = await Promise.all([
        protection.encryptText(owner.key, originalWording),
        protection.encryptText(owner.key, input.displayText),
        protection.encryptText(owner.key, input.smsSafeText)
      ])
      const reminderId = randomUuid()
      const occurrenceId = randomUuid()
      const createdAt = now().toISOString()
      const displayTime = localDisplay(dueAt, input.timeZone)
      await Effect.runPromise(
        allInTransaction(database, [
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
            ...ONE_SHOT_REMINDER_POLICY,
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
      )
      return { reminderId, occurrenceId, dueAt, localDisplayTime: displayTime, duplicate: false }
    },

    async list(ownerId) {
      const rows = await Effect.runPromise(
        database
          .select()
          .from(reminders)
          .where(and(eq(reminders.userId, ownerId), inArray(reminders.state, ["active", "paused"])))
          .orderBy(asc(reminders.nextDueAt))
      )
      const targetRows =
        rows.length === 0
          ? []
          : await Effect.runPromise(
              database
                .select({
                  reminderId: reminderOccurrences.reminderId,
                  occurrenceId: reminderOccurrences.id,
                  dueAt: reminderOccurrences.intendedDueAt,
                  localDisplayTime: reminderOccurrences.localDisplayTime,
                  state: reminderOccurrences.state
                })
                .from(reminderOccurrences)
                .where(
                  and(
                    inArray(
                      reminderOccurrences.reminderId,
                      rows.map((row) => row.id)
                    ),
                    inArray(reminderOccurrences.state, [
                      "scheduled",
                      "claimed",
                      "awaiting_delivery",
                      "awaiting_response",
                      "acknowledged"
                    ])
                  )
                )
                .orderBy(asc(reminderOccurrences.intendedDueAt), asc(reminderOccurrences.sequence))
            )
      const targetsByReminder = new Map<string, ReminderActionTarget[]>()
      for (const target of targetRows) {
        const targets = targetsByReminder.get(target.reminderId) ?? []
        targets.push({
          occurrenceId: target.occurrenceId,
          dueAt: target.dueAt,
          localDisplayTime: target.localDisplayTime,
          state: target.state
        })
        targetsByReminder.set(target.reminderId, targets)
      }
      const key = (await ownerDataKeys.load(ownerId)).key
      return Promise.all(
        rows.map(async (row) => {
          const displayText = await protection.decryptText(key, {
            ciphertext: row.displayTextCiphertext,
            iv: row.displayTextIv
          })
          const summary = {
            id: row.id,
            displayText,
            timeZone: row.timeZone,
            state: row.state,
            actionTargets: targetsByReminder.get(row.id) ?? []
          }
          if (row.nextDueAt === null) return summary
          return {
            ...summary,
            nextDueAt: row.nextDueAt,
            localDisplayTime: localDisplay(row.nextDueAt, row.timeZone)
          }
        })
      )
    },

    async acknowledge(ownerId, occurrenceId, idempotencyKey) {
      if (await actionExists(idempotencyKey)) return
      const occurrence = await ownedOccurrence(ownerId, occurrenceId)
      if (occurrence === undefined) throw new Error("Reminder occurrence not found")
      transitionOccurrence(occurrence.state, "acknowledged")
      const at = now().toISOString()
      const actionId = randomUuid()
      await Effect.runPromise(
        allInTransaction(database, [
          conditionalOccurrenceAction({
            id: actionId,
            ownerId,
            reminderId: occurrence.reminderId,
            sourceOccurrenceId: occurrenceId,
            expectedState: occurrence.state,
            actionOccurrenceId: occurrenceId,
            action: "acknowledged",
            idempotencyKey,
            createdAt: at
          }),
          database
            .update(reminderOccurrences)
            .set({ state: "acknowledged", updatedAt: at })
            .where(
              and(
                eq(reminderOccurrences.id, occurrenceId),
                eq(reminderOccurrences.state, occurrence.state),
                actionRecorded(actionId)
              )
            ),
          database
            .update(shortReplyBindings)
            .set({ consumedAt: at })
            .where(
              and(
                eq(shortReplyBindings.targetType, "reminder"),
                eq(shortReplyBindings.targetId, occurrenceId),
                eq(shortReplyBindings.command, "seen"),
                isNull(shortReplyBindings.consumedAt),
                actionRecorded(actionId)
              )
            )
        ])
      )
      if (!(await actionWasRecorded(actionId)) && !(await actionExists(idempotencyKey))) {
        throw new Error("Reminder occurrence changed before it could be acknowledged")
      }
    },

    async complete(ownerId, occurrenceId, idempotencyKey) {
      if (await actionExists(idempotencyKey)) return
      const occurrence = await ownedOccurrence(ownerId, occurrenceId)
      if (occurrence === undefined) throw new Error("Reminder occurrence not found")
      const [reminder] = await Effect.runPromise(
        database
          .select({ scheduleKind: reminders.scheduleKind })
          .from(reminders)
          .where(and(eq(reminders.id, occurrence.reminderId), eq(reminders.userId, ownerId)))
          .limit(1)
      )
      if (reminder === undefined) throw new Error("Reminder not found")
      transitionOccurrence(occurrence.state, "completed")
      const at = now().toISOString()
      const actionId = randomUuid()
      await Effect.runPromise(
        allInTransaction(database, [
          conditionalOccurrenceAction({
            id: actionId,
            ownerId,
            reminderId: occurrence.reminderId,
            sourceOccurrenceId: occurrenceId,
            expectedState: occurrence.state,
            actionOccurrenceId: occurrenceId,
            action: "completed",
            idempotencyKey,
            createdAt: at
          }),
          database
            .update(reminderOccurrences)
            .set({ state: "completed", updatedAt: at })
            .where(
              and(
                eq(reminderOccurrences.id, occurrenceId),
                eq(reminderOccurrences.state, occurrence.state),
                actionRecorded(actionId)
              )
            ),
          database
            .update(shortReplyBindings)
            .set({ consumedAt: at })
            .where(
              and(
                eq(shortReplyBindings.targetType, "reminder"),
                eq(shortReplyBindings.targetId, occurrenceId),
                isNull(shortReplyBindings.consumedAt),
                actionRecorded(actionId)
              )
            ),
          ...(reminder.scheduleKind === "one_shot"
            ? [
                database
                  .update(reminders)
                  .set({ state: "completed", nextDueAt: null, updatedAt: at })
                  .where(
                    and(
                      eq(reminders.id, occurrence.reminderId),
                      eq(reminders.userId, ownerId),
                      actionRecorded(actionId)
                    )
                  )
              ]
            : [])
        ])
      )
      if (!(await actionWasRecorded(actionId)) && !(await actionExists(idempotencyKey))) {
        throw new Error("Reminder occurrence changed before it could be completed")
      }
    },

    async applyBoundReply(ownerId, bindingId, command) {
      const at = now().toISOString()
      const idempotencyKey = `reply:${bindingId}:${command}`
      if (await actionExists(idempotencyKey)) return "applied"
      const [binding] = await Effect.runPromise(
        database
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
      )
      if (binding === undefined) return "invalid"
      const [occurrence] = await Effect.runPromise(
        database
          .select()
          .from(reminderOccurrences)
          .where(eq(reminderOccurrences.id, binding.targetId))
          .limit(1)
      )
      if (occurrence === undefined) return "invalid"
      const [reminder] = await Effect.runPromise(
        database
          .select({ scheduleKind: reminders.scheduleKind })
          .from(reminders)
          .where(and(eq(reminders.id, occurrence.reminderId), eq(reminders.userId, ownerId)))
          .limit(1)
      )
      if (reminder === undefined) return "invalid"
      const next = command === "seen" ? "acknowledged" : "completed"
      try {
        transitionOccurrence(occurrence.state, next)
      } catch {
        return "invalid"
      }
      const actionId = randomUuid()
      try {
        await Effect.runPromise(
          allInTransaction(database, [
            conditionalOccurrenceAction({
              id: actionId,
              ownerId,
              reminderId: occurrence.reminderId,
              sourceOccurrenceId: occurrence.id,
              expectedState: occurrence.state,
              actionOccurrenceId: occurrence.id,
              action: next,
              idempotencyKey,
              createdAt: at,
              extraCondition: sql<boolean>`exists (
              select 1 from ${shortReplyBindings}
              where ${shortReplyBindings.id} = ${binding.id}
                and ${shortReplyBindings.consumedAt} is null
                and ${shortReplyBindings.expiresAt} > ${at}
            )`
            }),
            database
              .update(shortReplyBindings)
              .set({ consumedAt: at })
              .where(
                and(
                  eq(shortReplyBindings.id, binding.id),
                  isNull(shortReplyBindings.consumedAt),
                  gt(shortReplyBindings.expiresAt, at),
                  actionRecorded(actionId)
                )
              ),
            database
              .update(reminderOccurrences)
              .set({ state: next, updatedAt: at })
              .where(
                and(
                  eq(reminderOccurrences.id, occurrence.id),
                  eq(reminderOccurrences.state, occurrence.state),
                  actionRecorded(actionId)
                )
              ),
            ...(next === "completed"
              ? [
                  database
                    .update(shortReplyBindings)
                    .set({ consumedAt: at })
                    .where(
                      and(
                        eq(shortReplyBindings.targetType, "reminder"),
                        eq(shortReplyBindings.targetId, occurrence.id),
                        isNull(shortReplyBindings.consumedAt),
                        actionRecorded(actionId)
                      )
                    )
                ]
              : []),
            ...(next === "completed" && reminder.scheduleKind === "one_shot"
              ? [
                  database
                    .update(reminders)
                    .set({ state: "completed", nextDueAt: null, updatedAt: at })
                    .where(
                      and(
                        eq(reminders.id, occurrence.reminderId),
                        eq(reminders.userId, ownerId),
                        actionRecorded(actionId)
                      )
                    )
                ]
              : [])
          ])
        )
      } catch {
        return (await actionExists(idempotencyKey)) ? "applied" : "invalid"
      }
      return (await actionWasRecorded(actionId)) || (await actionExists(idempotencyKey))
        ? "applied"
        : "invalid"
    },

    async snooze(ownerId, occurrenceId, dueAt, idempotencyKey) {
      const [existing] = await Effect.runPromise(
        database
          .select({ occurrenceId: reminderActions.occurrenceId })
          .from(reminderActions)
          .where(eq(reminderActions.idempotencyKey, idempotencyKey))
          .limit(1)
      )
      if (existing?.occurrenceId !== null && existing?.occurrenceId !== undefined)
        return existing.occurrenceId
      const occurrence = await ownedOccurrence(ownerId, occurrenceId)
      if (occurrence === undefined) throw new Error("Reminder occurrence not found")
      transitionOccurrence(occurrence.state, "snoozed")
      const [reminder] = await Effect.runPromise(
        database.select().from(reminders).where(eq(reminders.id, occurrence.reminderId)).limit(1)
      )
      if (reminder === undefined) throw new Error("Reminder not found")
      const successorId = randomUuid()
      const revision = reminder.scheduleRevision + 1
      const createdAt = now().toISOString()
      const actionId = randomUuid()
      try {
        await Effect.runPromise(
          allInTransaction(database, [
            conditionalOccurrenceAction({
              id: actionId,
              ownerId,
              reminderId: reminder.id,
              sourceOccurrenceId: occurrenceId,
              expectedState: occurrence.state,
              actionOccurrenceId: successorId,
              action: "snoozed",
              idempotencyKey,
              createdAt
            }),
            database
              .update(reminderOccurrences)
              .set({ state: "snoozed", snoozedToOccurrenceId: successorId, updatedAt: createdAt })
              .where(
                and(
                  eq(reminderOccurrences.id, occurrenceId),
                  eq(reminderOccurrences.state, occurrence.state),
                  actionRecorded(actionId)
                )
              ),
            conditionalScheduledOccurrence({
              actionId,
              id: successorId,
              reminderId: reminder.id,
              sequence: occurrence.sequence + 1,
              dueAt,
              localDisplayTime: localDisplay(dueAt, reminder.timeZone),
              idempotencyKey: occurrenceIdempotencyKey(reminder.id, dueAt, occurrence.sequence + 1),
              createdAt
            }),
            database
              .update(reminders)
              .set({ nextDueAt: dueAt, scheduleRevision: revision, updatedAt: createdAt })
              .where(and(eq(reminders.id, reminder.id), actionRecorded(actionId))),
            database
              .update(shortReplyBindings)
              .set({ consumedAt: createdAt })
              .where(
                and(
                  eq(shortReplyBindings.targetType, "reminder"),
                  eq(shortReplyBindings.targetId, occurrenceId),
                  isNull(shortReplyBindings.consumedAt),
                  actionRecorded(actionId)
                )
              ),
            conditionalSchedulerCommand({
              actionId,
              id: randomUuid(),
              ownerId: reminder.userId,
              reminderId: reminder.id,
              scheduleRevision: revision,
              command: "upsert",
              createdAt
            })
          ])
        )
      } catch (error) {
        const [settled] = await Effect.runPromise(
          database
            .select({ occurrenceId: reminderActions.occurrenceId })
            .from(reminderActions)
            .where(eq(reminderActions.idempotencyKey, idempotencyKey))
            .limit(1)
        )
        if (settled?.occurrenceId !== null && settled?.occurrenceId !== undefined) {
          return settled.occurrenceId
        }
        throw error
      }
      if (!(await actionWasRecorded(actionId))) {
        const [settled] = await Effect.runPromise(
          database
            .select({ occurrenceId: reminderActions.occurrenceId })
            .from(reminderActions)
            .where(eq(reminderActions.idempotencyKey, idempotencyKey))
            .limit(1)
        )
        if (settled?.occurrenceId !== null && settled?.occurrenceId !== undefined) {
          return settled.occurrenceId
        }
        throw new Error("Reminder occurrence changed before it could be snoozed")
      }
      return successorId
    },

    async cancel(ownerId, reminderId, occurrenceId, idempotencyKey) {
      if (await actionExists(idempotencyKey)) return
      const at = now().toISOString()
      const [reminder] = await Effect.runPromise(
        database
          .select()
          .from(reminders)
          .where(and(eq(reminders.id, reminderId), eq(reminders.userId, ownerId)))
          .limit(1)
      )
      if (reminder === undefined) throw new Error("Reminder not found")
      if (occurrenceId !== undefined) {
        const occurrence = await ownedOccurrence(ownerId, occurrenceId)
        if (occurrence === undefined || occurrence.reminderId !== reminderId) {
          throw new Error("Reminder occurrence not found")
        }
        transitionOccurrence(occurrence.state, "cancelled")
        const revision = reminder.scheduleRevision + 1
        const actionId = randomUuid()
        const statements: [DatabaseQuery, ...DatabaseQuery[]] = [
          conditionalOccurrenceAction({
            id: actionId,
            ownerId,
            reminderId,
            sourceOccurrenceId: occurrenceId,
            expectedState: occurrence.state,
            actionOccurrenceId: occurrenceId,
            action: "cancelled",
            idempotencyKey,
            createdAt: at
          }),
          database
            .update(reminderOccurrences)
            .set({ state: "cancelled", updatedAt: at })
            .where(
              and(
                eq(reminderOccurrences.id, occurrenceId),
                eq(reminderOccurrences.state, occurrence.state),
                actionRecorded(actionId)
              )
            ),
          database
            .update(shortReplyBindings)
            .set({ consumedAt: at })
            .where(
              and(
                eq(shortReplyBindings.targetType, "reminder"),
                eq(shortReplyBindings.targetId, occurrenceId),
                isNull(shortReplyBindings.consumedAt),
                actionRecorded(actionId)
              )
            )
        ]

        if (reminder.scheduleKind === "one_shot") {
          statements.push(
            database
              .update(reminders)
              .set({
                state: "cancelled",
                nextDueAt: null,
                scheduleRevision: revision,
                updatedAt: at
              })
              .where(
                and(
                  eq(reminders.id, reminderId),
                  eq(reminders.userId, ownerId),
                  actionRecorded(actionId)
                )
              ),
            conditionalSchedulerCommand({
              actionId,
              id: randomUuid(),
              ownerId: reminder.userId,
              reminderId,
              scheduleRevision: revision,
              command: "remove",
              createdAt: at
            })
          )
        } else {
          const existingOccurrences = await Effect.runPromise(
            database
              .select({
                id: reminderOccurrences.id,
                sequence: reminderOccurrences.sequence,
                intendedDueAt: reminderOccurrences.intendedDueAt,
                state: reminderOccurrences.state
              })
              .from(reminderOccurrences)
              .where(eq(reminderOccurrences.reminderId, reminderId))
          )
          const nextScheduled = existingOccurrences
            .filter((candidate) => candidate.id !== occurrenceId && candidate.state === "scheduled")
            .sort(
              (left, right) =>
                Date.parse(left.intendedDueAt) - Date.parse(right.intendedDueAt) ||
                left.sequence - right.sequence
            )[0]
          let nextDueAt = nextScheduled?.intendedDueAt

          if (nextDueAt === undefined) {
            if (reminder.rrule === null) {
              throw new Error("Recurring reminder rule not found")
            }
            const latestOccurrence = existingOccurrences.reduce((latest, candidate) =>
              candidate.sequence > latest.sequence ? candidate : latest
            )
            nextDueAt = nextRecurringDueAt(
              latestOccurrence.intendedDueAt,
              reminder.rrule,
              reminder.timeZone
            )
            const nextSequence = latestOccurrence.sequence + 1
            statements.push(
              conditionalScheduledOccurrence({
                actionId,
                id: randomUuid(),
                reminderId,
                sequence: nextSequence,
                dueAt: nextDueAt,
                localDisplayTime: localDisplay(nextDueAt, reminder.timeZone),
                idempotencyKey: occurrenceIdempotencyKey(reminderId, nextDueAt, nextSequence),
                createdAt: at
              })
            )
          }

          statements.push(
            database
              .update(reminders)
              .set({ nextDueAt, scheduleRevision: revision, updatedAt: at })
              .where(
                and(
                  eq(reminders.id, reminderId),
                  eq(reminders.userId, ownerId),
                  actionRecorded(actionId)
                )
              ),
            conditionalSchedulerCommand({
              actionId,
              id: randomUuid(),
              ownerId: reminder.userId,
              reminderId,
              scheduleRevision: revision,
              command: reminder.state === "active" ? "upsert" : "remove",
              createdAt: at
            })
          )
        }

        try {
          await Effect.runPromise(allInTransaction(database, statements))
        } catch (error) {
          if (await actionExists(idempotencyKey)) return
          throw error
        }
        if (!(await actionWasRecorded(actionId)) && !(await actionExists(idempotencyKey))) {
          throw new Error("Reminder occurrence changed before it could be cancelled")
        }
        return
      }
      const revision = reminder.scheduleRevision + 1
      const activeOccurrences = await Effect.runPromise(
        database
          .select({ id: reminderOccurrences.id })
          .from(reminderOccurrences)
          .where(eq(reminderOccurrences.reminderId, reminderId))
      )
      const statements: [DatabaseQuery, ...DatabaseQuery[]] = [
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
      await Effect.runPromise(allInTransaction(database, statements))
    },

    async releaseExpiredClaims(at) {
      const released = await Effect.runPromise(
        database
          .update(reminderOccurrences)
          .set({
            state: "scheduled",
            claimToken: null,
            claimedAt: null,
            claimExpiresAt: null,
            updatedAt: at
          })
          .where(
            and(
              eq(reminderOccurrences.state, "claimed"),
              lt(reminderOccurrences.claimExpiresAt, at)
            )
          )
          .returning({ id: reminderOccurrences.id })
      )
      return released.length
    },

    async markExpiredResponseDeadlines(at) {
      const expired = await Effect.runPromise(
        database
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
      )
      for (const row of expired) {
        await Effect.runPromise(
          allInTransaction(database, [
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
        )
      }
      return expired.length
    },

    async claimDueAndCreateOutbox(ownerId, leaseMs) {
      const timestamp = now()
      const timestampIso = timestamp.toISOString()
      const activeQuietHours = await ownerQuietHours(ownerId)
      let sentToday = 0
      if (dailyLimit !== undefined && activeQuietHours !== undefined) {
        const bounds = localDayBounds(timestampIso, activeQuietHours.timeZone)
        const [count] = await Effect.runPromise(
          database
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
        )
        sentToday = Number(count?.count ?? 0)
      }
      const due = await Effect.runPromise(
        database
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
      )
      const outboxIds: string[] = []
      for (const row of due) {
        const quietDeferredAt =
          activeQuietHours === undefined || row.reminder.quietHoursBehavior === "allow"
            ? timestampIso
            : deferForQuietHours(timestampIso, activeQuietHours)
        const limited =
          dailyLimit !== undefined && activeQuietHours !== undefined && sentToday >= dailyLimit
        if (quietDeferredAt !== timestampIso || limited) {
          const deferredAt =
            limited && activeQuietHours !== undefined
              ? nextDailyWindow(timestampIso, activeQuietHours)
              : quietDeferredAt
          await Effect.runPromise(
            allInTransaction(database, [
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
          )
          continue
        }
        const claimToken = randomUuid()
        const [claimed] = await Effect.runPromise(
          database
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
        )
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
          await Effect.runPromise(
            allInTransaction(database, [
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
          )
        } else {
          await Effect.runPromise(
            allInTransaction(database, [
              ...statements,
              database
                .update(reminders)
                .set({ nextDueAt: null, updatedAt: timestamp.toISOString() })
                .where(eq(reminders.id, row.reminder.id))
            ])
          )
        }
        outboxIds.push(outboxId)
        sentToday += 1
      }
      return outboxIds
    },

    async nextDue(ownerId) {
      const [next] = await Effect.runPromise(
        database
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
      )
      return next?.dueAt
    }
  }
}

export function reminderStoreLayer(store: ReminderStore) {
  return Layer.succeed(ReminderStore, store)
}
