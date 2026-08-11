import { applyD1Migrations, reset } from "cloudflare:test"
import { env } from "cloudflare:workers"
import { eq } from "drizzle-orm"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { createCoreDatabase } from "../src/database.ts"
import {
  channels,
  messages,
  shortReplyBindings,
  users
} from "../src/modules/conversations/schema.ts"
import { createDataProtection } from "../src/modules/policy/data-protection.ts"
import { reminderActions, reminderOccurrences, reminders } from "../src/modules/reminders/schema.ts"
import { makeReminderStore } from "../src/modules/reminders/store.ts"
import { decodeTestMigrations } from "./migrations.ts"

declare global {
  namespace Cloudflare {
    interface Env {
      DB: D1Database
      TEST_MIGRATIONS: string
    }
  }
}

const ownerId = "00000000-0000-4000-8000-000000000001"
const channelId = "00000000-0000-4000-8000-000000000002"
const messageId = "00000000-0000-4000-8000-000000000003"
const at = "2026-08-11T10:00:00.000Z"

function key(byte: number): string {
  let binary = ""
  for (const value of new Uint8Array(32).fill(byte)) binary += String.fromCharCode(value)
  return btoa(binary)
}

async function reminderFixture() {
  const database = createCoreDatabase(env.DB)
  const protection = createDataProtection({ 1: key(1) }, 1, key(2))
  const wrapped = await protection.createWrappedDataKey()
  const sender = await protection.encryptText(wrapped.key, "+46700000000")
  const destination = await protection.encryptText(wrapped.key, "+46711111111")
  const text = await protection.encryptText(wrapped.key, "Reminder source")
  await database.batch([
    database.insert(users).values({
      id: ownerId,
      timeZone: "Europe/Stockholm",
      wrappedDataKey: wrapped.wrapped.ciphertext,
      wrappedDataKeyIv: wrapped.wrapped.iv,
      dataKeyVersion: wrapped.wrapped.version,
      createdAt: at,
      updatedAt: at
    }),
    database.insert(channels).values({
      id: channelId,
      userId: ownerId,
      provider: "sendblue",
      accountId: "account",
      lineId: "line",
      senderHash: await protection.hashLookup("+46700000000"),
      senderCiphertext: sender.ciphertext,
      senderIv: sender.iv,
      destinationHash: await protection.hashLookup("+46711111111"),
      destinationCiphertext: destination.ciphertext,
      destinationIv: destination.iv,
      createdAt: at
    }),
    database.insert(messages).values({
      id: messageId,
      userId: ownerId,
      channelId,
      direction: "inbound",
      textCiphertext: text.ciphertext,
      textIv: text.iv,
      dataKeyVersion: 1,
      occurredAt: at,
      createdAt: at
    })
  ])
  let next = 100
  const store = makeReminderStore(database, protection, {
    now: () => new Date(at),
    randomUuid: () => `00000000-0000-4000-8000-${String(next++).padStart(12, "0")}`
  })
  const created = await store.createOneShot(
    ownerId,
    channelId,
    "Remind me to have lunch at 13:00.",
    {
      displayText: "Lunch",
      smsSafeText: "Lunch",
      localDate: "2026-08-11",
      localTime: "13:00",
      timeZone: "Europe/Stockholm",
      dueAt: "2026-08-11T11:00:00.000Z",
      sourceMessageId: messageId,
      requiresAcknowledgment: true
    },
    "reminder:create"
  )
  await database
    .update(reminderOccurrences)
    .set({ state: "awaiting_response" })
    .where(eq(reminderOccurrences.id, created.occurrenceId))
  return { database, store, created }
}

beforeEach(async () => {
  await applyD1Migrations(env.DB, decodeTestMigrations(env.TEST_MIGRATIONS))
})

afterEach(async () => {
  await reset()
})

describe("reminder mutation atomicity", () => {
  it("lets one concurrent terminal response change an occurrence", async () => {
    const { database, store, created } = await reminderFixture()
    const operations = [
      () => store.acknowledge(ownerId, created.occurrenceId, "reminder:race:seen"),
      () => store.complete(ownerId, created.occurrenceId, "reminder:race:done")
    ] as const

    const outcomes = await Promise.allSettled(operations.map((operation) => operation()))

    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1)
    const actions = await database
      .select()
      .from(reminderActions)
      .where(eq(reminderActions.reminderId, created.reminderId))
    expect(actions.filter((action) => action.action !== "created")).toHaveLength(1)

    const winningIndex = outcomes.findIndex((outcome) => outcome.status === "fulfilled")
    await expect(operations[winningIndex]!()).resolves.toBeUndefined()
    const listed = await store.list(ownerId)
    const [savedReminder] = await database
      .select()
      .from(reminders)
      .where(eq(reminders.id, created.reminderId))
    if (winningIndex === 0) {
      expect(listed).toMatchObject([
        { actionTargets: [{ occurrenceId: created.occurrenceId, state: "acknowledged" }] }
      ])
      expect(savedReminder?.state).toBe("active")
    } else {
      expect(listed).toEqual([])
      expect(savedReminder?.state).toBe("completed")
    }
  })

  it("applies one of two concurrent short replies", async () => {
    const { database, store, created } = await reminderFixture()
    const seenBindingId = "00000000-0000-4000-8000-000000000201"
    const secondSeenBindingId = "00000000-0000-4000-8000-000000000202"
    await database.batch([
      database.insert(shortReplyBindings).values({
        id: seenBindingId,
        userId: ownerId,
        outboundMessageId: messageId,
        command: "seen",
        targetType: "reminder",
        targetId: created.occurrenceId,
        expiresAt: "2026-08-11T11:00:00.000Z",
        createdAt: at
      }),
      database.insert(shortReplyBindings).values({
        id: secondSeenBindingId,
        userId: ownerId,
        outboundMessageId: "00000000-0000-4000-8000-000000000203",
        command: "seen",
        targetType: "reminder",
        targetId: created.occurrenceId,
        expiresAt: "2026-08-11T11:00:00.000Z",
        createdAt: at
      })
    ])

    const outcomes = await Promise.allSettled([
      store.applyBoundReply(ownerId, seenBindingId, "seen"),
      store.applyBoundReply(ownerId, secondSeenBindingId, "seen")
    ])

    expect(outcomes).toEqual(
      expect.arrayContaining([
        { status: "fulfilled", value: "applied" },
        { status: "fulfilled", value: "invalid" }
      ])
    )
    const actions = await database
      .select()
      .from(reminderActions)
      .where(eq(reminderActions.reminderId, created.reminderId))
    expect(actions.filter((action) => action.action !== "created")).toHaveLength(1)
    await expect(store.list(ownerId)).resolves.toMatchObject([
      { actionTargets: [{ occurrenceId: created.occurrenceId, state: "acknowledged" }] }
    ])
  })

  it("does not create a snooze successor after another transition wins", async () => {
    const { database, store, created } = await reminderFixture()
    const snoozeDueAt = "2026-08-11T12:00:00.000Z"
    const outcomes = await Promise.allSettled([
      store.acknowledge(ownerId, created.occurrenceId, "reminder:race:snooze-seen"),
      store.snooze(ownerId, created.occurrenceId, snoozeDueAt, "reminder:race:snooze")
    ])

    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1)
    const savedOccurrences = await database
      .select()
      .from(reminderOccurrences)
      .where(eq(reminderOccurrences.reminderId, created.reminderId))
    const savedActions = await database
      .select()
      .from(reminderActions)
      .where(eq(reminderActions.reminderId, created.reminderId))
    expect(savedActions.filter((action) => action.action !== "created")).toHaveLength(1)

    const winningIndex = outcomes.findIndex((outcome) => outcome.status === "fulfilled")
    if (winningIndex === 0) {
      expect(savedOccurrences).toHaveLength(1)
      await expect(store.list(ownerId)).resolves.toMatchObject([
        { actionTargets: [{ occurrenceId: created.occurrenceId, state: "acknowledged" }] }
      ])
      await expect(
        store.acknowledge(ownerId, created.occurrenceId, "reminder:race:snooze-seen")
      ).resolves.toBeUndefined()
    } else {
      expect(savedOccurrences).toHaveLength(2)
      await expect(store.list(ownerId)).resolves.toMatchObject([
        {
          nextDueAt: snoozeDueAt,
          actionTargets: [{ state: "scheduled", dueAt: snoozeDueAt }]
        }
      ])
      await expect(
        store.snooze(ownerId, created.occurrenceId, snoozeDueAt, "reminder:race:snooze")
      ).resolves.toBe(outcomes[1]?.status === "fulfilled" ? outcomes[1].value : undefined)
    }
  })

  it("does not close a reminder after occurrence cancellation loses", async () => {
    const { database, store, created } = await reminderFixture()
    const outcomes = await Promise.allSettled([
      store.cancel(ownerId, created.reminderId, created.occurrenceId, "reminder:race:cancel"),
      store.acknowledge(ownerId, created.occurrenceId, "reminder:race:cancel-seen")
    ])

    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1)
    const savedActions = await database
      .select()
      .from(reminderActions)
      .where(eq(reminderActions.reminderId, created.reminderId))
    expect(savedActions.filter((action) => action.action !== "created")).toHaveLength(1)
    const [savedReminder] = await database
      .select()
      .from(reminders)
      .where(eq(reminders.id, created.reminderId))

    if (outcomes[0]?.status === "fulfilled") {
      expect(savedReminder).toMatchObject({ state: "cancelled", scheduleRevision: 2 })
      await expect(store.list(ownerId)).resolves.toEqual([])
    } else {
      expect(savedReminder).toMatchObject({ state: "active", scheduleRevision: 1 })
      await expect(store.list(ownerId)).resolves.toMatchObject([
        { actionTargets: [{ occurrenceId: created.occurrenceId, state: "acknowledged" }] }
      ])
    }
  })

  it("does not create a recurring successor after cancellation loses", async () => {
    const { database, store, created } = await reminderFixture()
    await database
      .update(reminders)
      .set({ scheduleKind: "recurring", rrule: "RRULE:FREQ=DAILY;INTERVAL=1" })
      .where(eq(reminders.id, created.reminderId))

    const outcomes = await Promise.allSettled([
      store.cancel(
        ownerId,
        created.reminderId,
        created.occurrenceId,
        "reminder:race:recurring-cancel"
      ),
      store.acknowledge(ownerId, created.occurrenceId, "reminder:race:recurring-seen")
    ])

    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1)
    const savedOccurrences = await database
      .select()
      .from(reminderOccurrences)
      .where(eq(reminderOccurrences.reminderId, created.reminderId))
    const savedActions = await database
      .select()
      .from(reminderActions)
      .where(eq(reminderActions.reminderId, created.reminderId))
    expect(savedActions.filter((action) => action.action !== "created")).toHaveLength(1)

    if (outcomes[0]?.status === "fulfilled") {
      expect(savedOccurrences).toHaveLength(2)
      await expect(store.list(ownerId)).resolves.toMatchObject([
        { actionTargets: [{ state: "scheduled" }] }
      ])
    } else {
      expect(savedOccurrences).toHaveLength(1)
      await expect(store.list(ownerId)).resolves.toMatchObject([
        { actionTargets: [{ occurrenceId: created.occurrenceId, state: "acknowledged" }] }
      ])
    }
  })
})
