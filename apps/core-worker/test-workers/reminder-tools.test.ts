import { applyD1Migrations, reset } from "cloudflare:test"
import { env } from "cloudflare:workers"
import { eq } from "drizzle-orm"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { createCoreDatabase } from "../src/database.ts"
import { makeAgentRunStore } from "../src/modules/conversations/run-store.ts"
import {
  agentRuns,
  channels,
  inboundEvents,
  messages,
  users
} from "../src/modules/conversations/schema.ts"
import { makeToolExecutor } from "../src/modules/conversations/tool-executor.ts"
import { createDataProtection } from "../src/modules/policy/data-protection.ts"
import { reminderOccurrences, reminders, schedulerOutbox } from "../src/modules/reminders/schema.ts"
import { makeReminderStore, type ReminderStore } from "../src/modules/reminders/store.ts"
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
const inboundId = "00000000-0000-4000-8000-000000000003"
const messageId = "00000000-0000-4000-8000-000000000004"
const runId = "00000000-0000-4000-8000-000000000005"
const correlationId = "00000000-0000-4000-8000-000000000006"

function key(byte: number): string {
  let binary = ""
  for (const value of new Uint8Array(32).fill(byte)) binary += String.fromCharCode(value)
  return btoa(binary)
}

async function reminderToolFixture(userText = "Remind me at 13:00.") {
  const database = createCoreDatabase(env.DB)
  const protection = createDataProtection({ 1: key(1) }, 1, key(2))
  const wrapped = await protection.createWrappedDataKey()
  const sender = await protection.encryptText(wrapped.key, "+46700000000")
  const destination = await protection.encryptText(wrapped.key, "+46711111111")
  const inboundText = await protection.encryptText(wrapped.key, userText)
  const senderHash = await protection.hashLookup("+46700000000")
  const destinationHash = await protection.hashLookup("+46711111111")
  const at = "2026-08-11T10:00:00.000Z"
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
      senderHash,
      senderCiphertext: sender.ciphertext,
      senderIv: sender.iv,
      destinationHash,
      destinationCiphertext: destination.ciphertext,
      destinationIv: destination.iv,
      createdAt: at
    }),
    database.insert(messages).values({
      id: messageId,
      userId: ownerId,
      channelId,
      direction: "inbound",
      textCiphertext: inboundText.ciphertext,
      textIv: inboundText.iv,
      dataKeyVersion: 1,
      occurredAt: at,
      createdAt: at
    }),
    database.insert(inboundEvents).values({
      id: inboundId,
      userId: ownerId,
      channelId,
      messageId,
      accountId: "account",
      lineId: "line",
      providerMessageHandle: "provider-handle",
      correlationId,
      createdAt: at
    })
  ])

  const reminders = makeReminderStore(database, protection, {
    now: () => new Date(at)
  })
  const runs = makeAgentRunStore(database, protection, { now: () => new Date(at) })
  await runs.create(
    {
      protocolVersion: 1,
      runId,
      ownerId,
      correlationId,
      sourceMessageId: messageId,
      localTime: at,
      timeZone: "Europe/Stockholm",
      userText,
      contextItems: [],
      allowedTools: [
        "reminder_create",
        "reminder_list",
        "reminder_acknowledge",
        "reminder_complete",
        "reminder_snooze",
        "reminder_cancel"
      ],
      limits: {
        maxTurns: 4,
        maxToolCalls: 6,
        maxDurationMs: 60_000,
        maxResponseCharacters: 1_200
      }
    },
    inboundId
  )
  await runs.claim(runId, 90_000)
  const executor = makeToolExecutor(
    database,
    protection,
    {
      reminders,
      memory: {} as never,
      journal: {} as never,
      training: {} as never,
      settings: {} as never
    },
    { uiBaseUrl: "https://bob.example.invalid", now: () => new Date(at) }
  )
  return { database, executor, reminders }
}

function createReminder(
  reminderStore: ReminderStore,
  idempotencyKey: string,
  displayText = "Lunch"
) {
  return reminderStore.createOneShot(
    ownerId,
    channelId,
    "Remind me to have lunch at 13:00.",
    {
      displayText,
      smsSafeText: displayText,
      localDate: "2026-08-11",
      localTime: "13:00",
      timeZone: "Europe/Stockholm",
      dueAt: "2026-08-11T11:00:00.000Z",
      sourceMessageId: messageId,
      requiresAcknowledgment: true
    },
    idempotencyKey
  )
}

beforeEach(async () => {
  await applyD1Migrations(env.DB, decodeTestMigrations(env.TEST_MIGRATIONS))
})

afterEach(async () => {
  await reset()
})

describe("reminder tools", () => {
  it("rejects a delayed mutation after its agent run completes", async () => {
    const { database, executor, reminders: reminderStore } = await reminderToolFixture("Done.")
    const created = await createReminder(reminderStore, "reminder-store:create-late")
    await database
      .update(reminderOccurrences)
      .set({ state: "awaiting_response" })
      .where(eq(reminderOccurrences.id, created.occurrenceId))
    await database.update(agentRuns).set({ status: "completed" }).where(eq(agentRuns.id, runId))

    await expect(
      executor.execute({
        runId,
        toolCallId: "late-done-1",
        idempotencyKey: "reminder-tool:late-done-1",
        ownerId,
        name: "reminder_complete",
        arguments: { occurrenceId: created.occurrenceId }
      })
    ).resolves.toMatchObject({ ok: false, code: "policy_denied" })

    await expect(reminderStore.list(ownerId)).resolves.toMatchObject([
      { actionTargets: [{ occurrenceId: created.occurrenceId, state: "awaiting_response" }] }
    ])
  })

  it("rejects a mutation after its agent run lease expires", async () => {
    const { database, executor, reminders: reminderStore } = await reminderToolFixture("Done.")
    const created = await createReminder(reminderStore, "reminder-store:create-expired")
    await database.batch([
      database
        .update(reminderOccurrences)
        .set({ state: "awaiting_response" })
        .where(eq(reminderOccurrences.id, created.occurrenceId)),
      database
        .update(agentRuns)
        .set({ claimExpiresAt: "2026-08-11T09:59:59.000Z" })
        .where(eq(agentRuns.id, runId))
    ])

    await expect(
      executor.execute({
        runId,
        toolCallId: "expired-done-1",
        idempotencyKey: "reminder-tool:expired-done-1",
        ownerId,
        name: "reminder_complete",
        arguments: { occurrenceId: created.occurrenceId }
      })
    ).resolves.toMatchObject({ ok: false, code: "policy_denied" })

    await expect(reminderStore.list(ownerId)).resolves.toMatchObject([
      { actionTargets: [{ occurrenceId: created.occurrenceId, state: "awaiting_response" }] }
    ])
  })

  it("requires a choice before changing one of two reminders", async () => {
    const { executor, reminders: reminderStore } = await reminderToolFixture("Cancel my reminder.")
    const lunch = await createReminder(reminderStore, "reminder-store:create-lunch", "Lunch")
    await createReminder(reminderStore, "reminder-store:create-dinner", "Dinner")

    await expect(
      executor.execute({
        runId,
        toolCallId: "ambiguous-cancel-1",
        idempotencyKey: "reminder-tool:ambiguous-cancel-1",
        ownerId,
        name: "reminder_cancel",
        arguments: { reminderId: lunch.reminderId }
      })
    ).resolves.toMatchObject({ ok: false, code: "choice_required" })

    await expect(reminderStore.list(ownerId)).resolves.toHaveLength(2)
  })

  it("changes the one reminder named by the owner", async () => {
    const { executor, reminders: reminderStore } = await reminderToolFixture(
      "Cancel the Lunch reminder."
    )
    const lunch = await createReminder(reminderStore, "reminder-store:create-named-lunch", "Lunch")
    await createReminder(reminderStore, "reminder-store:create-named-dinner", "Dinner")

    await expect(
      executor.execute({
        runId,
        toolCallId: "named-cancel-1",
        idempotencyKey: "reminder-tool:named-cancel-1",
        ownerId,
        name: "reminder_cancel",
        arguments: { reminderId: lunch.reminderId }
      })
    ).resolves.toMatchObject({ ok: true, code: "reminder_cancelled" })

    await expect(reminderStore.list(ownerId)).resolves.toMatchObject([
      { displayText: "Dinner", state: "active" }
    ])
  })

  it("creates one reminder and lists its exact action target", async () => {
    const { executor } = await reminderToolFixture()
    const created = await executor.execute({
      runId,
      toolCallId: "create-1",
      idempotencyKey: "reminder-tool:create-1",
      ownerId,
      name: "reminder_create",
      arguments: {
        displayText: "Lunch",
        smsSafeText: "Lunch",
        localDate: "2026-08-11",
        localTime: "13:00",
        timeZone: "Europe/Stockholm",
        dueAt: "2026-08-11T11:00:00.000Z",
        sourceMessageId: messageId,
        requiresAcknowledgment: true
      }
    })
    expect(created).toMatchObject({ ok: true, code: "reminder_created" })

    const listed = await executor.execute({
      runId,
      toolCallId: "list-1",
      idempotencyKey: "reminder-tool:list-1",
      ownerId,
      name: "reminder_list",
      arguments: {}
    })
    expect(listed).toMatchObject({
      ok: true,
      code: "reminder_list",
      data: {
        reminders: [
          {
            id: created.data?.reminderId,
            displayText: "Lunch",
            actionTargets: [
              {
                occurrenceId: created.data?.occurrenceId,
                state: "scheduled"
              }
            ]
          }
        ]
      }
    })
  })

  it("marks one exact delivered occurrence as seen idempotently", async () => {
    const { database, executor, reminders: reminderStore } = await reminderToolFixture("Seen.")
    const created = await createReminder(reminderStore, "reminder-store:create-seen")
    const occurrenceId = created.occurrenceId
    await database
      .update(reminderOccurrences)
      .set({ state: "awaiting_response" })
      .where(eq(reminderOccurrences.id, occurrenceId))
    const command = {
      runId,
      toolCallId: "seen-1",
      idempotencyKey: "reminder-tool:seen-1",
      ownerId,
      name: "reminder_acknowledge" as const,
      arguments: { occurrenceId }
    }

    const first = await executor.execute(command)
    const retry = await executor.execute(command)

    expect(first).toMatchObject({ ok: true, code: "reminder_seen" })
    expect(retry).toEqual(first)
    const listed = await executor.execute({
      runId,
      toolCallId: "list-seen",
      idempotencyKey: "reminder-tool:list-seen",
      ownerId,
      name: "reminder_list",
      arguments: {}
    })
    expect(listed).toMatchObject({
      data: {
        reminders: [
          {
            actionTargets: [{ occurrenceId, state: "acknowledged" }]
          }
        ]
      }
    })
  })

  it("completes one exact delivered occurrence idempotently", async () => {
    const { database, executor, reminders: reminderStore } = await reminderToolFixture("Done.")
    const created = await createReminder(reminderStore, "reminder-store:create-done")
    const occurrenceId = created.occurrenceId
    await database
      .update(reminderOccurrences)
      .set({ state: "awaiting_response" })
      .where(eq(reminderOccurrences.id, occurrenceId))
    const completeCommand = {
      runId,
      toolCallId: "done-1",
      idempotencyKey: "reminder-tool:done-1",
      ownerId,
      name: "reminder_complete" as const,
      arguments: { occurrenceId }
    }
    const completed = await executor.execute(completeCommand)
    expect(completed).toMatchObject({ ok: true, code: "reminder_done" })
    await expect(executor.execute(completeCommand)).resolves.toEqual(completed)

    const afterCompletion = await executor.execute({
      runId,
      toolCallId: "list-done",
      idempotencyKey: "reminder-tool:list-done",
      ownerId,
      name: "reminder_list",
      arguments: {}
    })
    expect(afterCompletion).toMatchObject({
      data: { reminders: [] }
    })
  })

  it("snoozes one exact occurrence idempotently", async () => {
    const {
      database,
      executor,
      reminders: reminderStore
    } = await reminderToolFixture("Snooze this reminder until 14:00.")
    const created = await createReminder(reminderStore, "reminder-store:create-snooze")
    const occurrenceId = created.occurrenceId
    await database
      .update(reminderOccurrences)
      .set({ state: "awaiting_response" })
      .where(eq(reminderOccurrences.id, occurrenceId))
    const command = {
      runId,
      toolCallId: "snooze-1",
      idempotencyKey: "reminder-tool:snooze-1",
      ownerId,
      name: "reminder_snooze" as const,
      arguments: {
        occurrenceId,
        localDate: "2026-08-11",
        localTime: "14:00",
        timeZone: "Europe/Stockholm",
        dueAt: "2026-08-11T12:00:00.000Z"
      }
    }

    const first = await executor.execute(command)
    const retry = await executor.execute(command)

    expect(first).toMatchObject({
      ok: true,
      code: "reminder_snoozed",
      data: { dueAt: "2026-08-11T12:00:00.000Z" }
    })
    expect(retry).toEqual(first)
    const successorOccurrenceId = String(first.data?.occurrenceId)
    const listed = await executor.execute({
      runId,
      toolCallId: "list-snooze",
      idempotencyKey: "reminder-tool:list-snooze",
      ownerId,
      name: "reminder_list",
      arguments: {}
    })
    expect(listed).toMatchObject({
      data: {
        reminders: [
          {
            actionTargets: [
              {
                occurrenceId: successorOccurrenceId,
                dueAt: "2026-08-11T12:00:00.000Z",
                state: "scheduled"
              }
            ]
          }
        ]
      }
    })
  })

  it("closes a one-shot reminder when its occurrence is cancelled", async () => {
    const {
      database,
      executor,
      reminders: reminderStore
    } = await reminderToolFixture("Cancel the Lunch reminder for 2026-08-11.")
    const created = await createReminder(reminderStore, "reminder-store:create-cancel")
    const command = {
      runId,
      toolCallId: "cancel-occurrence-1",
      idempotencyKey: "reminder-tool:cancel-occurrence-1",
      ownerId,
      name: "reminder_cancel" as const,
      arguments: { reminderId: created.reminderId, occurrenceId: created.occurrenceId }
    }

    const cancelledOccurrence = await executor.execute(command)
    expect(cancelledOccurrence).toMatchObject({
      ok: true,
      code: "reminder_occurrence_cancelled"
    })
    await expect(executor.execute(command)).resolves.toEqual(cancelledOccurrence)

    const [savedReminder] = await database
      .select()
      .from(reminders)
      .where(eq(reminders.id, created.reminderId))
    expect(savedReminder).toMatchObject({
      state: "cancelled",
      nextDueAt: null,
      scheduleRevision: 2
    })
    const schedulerCommands = await database
      .select()
      .from(schedulerOutbox)
      .where(eq(schedulerOutbox.reminderId, created.reminderId))
    expect(schedulerCommands).toEqual(
      expect.arrayContaining([expect.objectContaining({ command: "remove", scheduleRevision: 2 })])
    )

    const afterCancellation = await executor.execute({
      runId,
      toolCallId: "list-cancelled",
      idempotencyKey: "reminder-tool:list-cancelled",
      ownerId,
      name: "reminder_list",
      arguments: {}
    })
    expect(afterCancellation).toMatchObject({ data: { reminders: [] } })
  })

  it("creates the next recurring occurrence after an occurrence cancellation", async () => {
    const {
      database,
      executor,
      reminders: reminderStore
    } = await reminderToolFixture("Avbryt påminnelsen.")
    const created = await createReminder(reminderStore, "reminder-store:create-recurring")
    await database
      .update(reminders)
      .set({ scheduleKind: "recurring", rrule: "RRULE:FREQ=DAILY;INTERVAL=1" })
      .where(eq(reminders.id, created.reminderId))
    const command = {
      runId,
      toolCallId: "cancel-recurring-1",
      idempotencyKey: "reminder-tool:cancel-recurring-1",
      ownerId,
      name: "reminder_cancel" as const,
      arguments: { reminderId: created.reminderId, occurrenceId: created.occurrenceId }
    }

    const result = await executor.execute(command)
    await expect(executor.execute(command)).resolves.toEqual(result)

    expect(result).toMatchObject({ ok: true, code: "reminder_occurrence_cancelled" })
    const occurrences = await database
      .select()
      .from(reminderOccurrences)
      .where(eq(reminderOccurrences.reminderId, created.reminderId))
    expect(occurrences).toHaveLength(2)
    expect(occurrences).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: created.occurrenceId, state: "cancelled", sequence: 1 }),
        expect.objectContaining({ state: "scheduled", sequence: 2 })
      ])
    )
    const successor = occurrences.find((occurrence) => occurrence.sequence === 2)
    expect(Date.parse(String(successor?.intendedDueAt))).toBe(
      Date.parse("2026-08-12T11:00:00.000Z")
    )
    const [savedReminder] = await database
      .select()
      .from(reminders)
      .where(eq(reminders.id, created.reminderId))
    expect(Date.parse(String(savedReminder?.nextDueAt))).toBe(
      Date.parse("2026-08-12T11:00:00.000Z")
    )
    expect(savedReminder).toMatchObject({ state: "active", scheduleRevision: 2 })
  })

  it("advances a recurring reminder to its existing next occurrence", async () => {
    const {
      database,
      executor,
      reminders: reminderStore
    } = await reminderToolFixture("Cancel the Lunch reminder for 2026-08-11.")
    const created = await createReminder(reminderStore, "reminder-store:create-recurring-next")
    await database.batch([
      database
        .update(reminders)
        .set({
          scheduleKind: "recurring",
          rrule: "RRULE:FREQ=DAILY;INTERVAL=1",
          nextDueAt: "2026-08-12T11:00:00.000Z"
        })
        .where(eq(reminders.id, created.reminderId)),
      database.insert(reminderOccurrences).values({
        id: "00000000-0000-4000-8000-000000000099",
        reminderId: created.reminderId,
        sequence: 2,
        intendedDueAt: "2026-08-12T11:00:00.000Z",
        localDisplayTime: "2026-08-12T13:00+02:00[Europe/Stockholm]",
        idempotencyKey: "reminder:test:existing-successor",
        state: "scheduled",
        createdAt: "2026-08-11T10:00:00.000Z",
        updatedAt: "2026-08-11T10:00:00.000Z"
      })
    ])

    const result = await executor.execute({
      runId,
      toolCallId: "cancel-recurring-existing",
      idempotencyKey: "reminder-tool:cancel-recurring-existing",
      ownerId,
      name: "reminder_cancel",
      arguments: { reminderId: created.reminderId, occurrenceId: created.occurrenceId }
    })

    expect(result).toMatchObject({ ok: true, code: "reminder_occurrence_cancelled" })
    const occurrences = await database
      .select()
      .from(reminderOccurrences)
      .where(eq(reminderOccurrences.reminderId, created.reminderId))
    expect(occurrences).toHaveLength(2)
    const [savedReminder] = await database
      .select()
      .from(reminders)
      .where(eq(reminders.id, created.reminderId))
    expect(savedReminder).toMatchObject({
      nextDueAt: "2026-08-12T11:00:00.000Z",
      scheduleRevision: 2
    })
  })

  it("rejects negated reminder mutations", async () => {
    const { executor } = await reminderToolFixture("Do not remind me tomorrow.")
    const result = await executor.execute({
      runId,
      toolCallId: "negated-create",
      idempotencyKey: "reminder-tool:negated-create",
      ownerId,
      name: "reminder_create",
      arguments: {
        displayText: "Lunch",
        smsSafeText: "Lunch",
        localDate: "2026-08-11",
        localTime: "13:00",
        timeZone: "Europe/Stockholm",
        dueAt: "2026-08-11T11:00:00.000Z",
        sourceMessageId: messageId,
        requiresAcknowledgment: true
      }
    })

    expect(result).toMatchObject({ ok: false, code: "confirmation_required" })
  })

  it("rejects mismatched and non-future create times", async () => {
    const { executor } = await reminderToolFixture()
    const baseArguments = {
      displayText: "Lunch",
      smsSafeText: "Lunch",
      localDate: "2026-08-11",
      timeZone: "Europe/Stockholm",
      sourceMessageId: messageId,
      requiresAcknowledgment: true
    }
    const mismatched = await executor.execute({
      runId,
      toolCallId: "mismatched-create",
      idempotencyKey: "reminder-tool:mismatched-create",
      ownerId,
      name: "reminder_create",
      arguments: {
        ...baseArguments,
        localTime: "13:00",
        dueAt: "2026-08-11T12:00:00.000Z"
      }
    })
    const notFuture = await executor.execute({
      runId,
      toolCallId: "past-create",
      idempotencyKey: "reminder-tool:past-create",
      ownerId,
      name: "reminder_create",
      arguments: {
        ...baseArguments,
        localTime: "12:00",
        dueAt: "2026-08-11T10:00:00.000Z"
      }
    })

    expect(mismatched).toMatchObject({ ok: false, code: "due_time_mismatch" })
    expect(notFuture).toMatchObject({ ok: false, code: "invalid_due_time" })
  })

  it("rejects a reminder date that the owner did not request", async () => {
    const { executor } = await reminderToolFixture("Remind me at 13:00.")

    await expect(
      executor.execute({
        runId,
        toolCallId: "unbound-date-create",
        idempotencyKey: "reminder-tool:unbound-date-create",
        ownerId,
        name: "reminder_create",
        arguments: {
          displayText: "Lunch",
          smsSafeText: "Lunch",
          localDate: "2026-08-12",
          localTime: "13:00",
          timeZone: "Europe/Stockholm",
          dueAt: "2026-08-12T11:00:00.000Z",
          sourceMessageId: messageId,
          requiresAcknowledgment: true
        }
      })
    ).resolves.toMatchObject({ ok: false, code: "confirmation_required" })
  })

  it("creates a reminder when the owner names tomorrow and the exact time", async () => {
    const { executor } = await reminderToolFixture("Remind me tomorrow at 13:00.")

    await expect(
      executor.execute({
        runId,
        toolCallId: "tomorrow-create",
        idempotencyKey: "reminder-tool:tomorrow-create",
        ownerId,
        name: "reminder_create",
        arguments: {
          displayText: "Lunch",
          smsSafeText: "Lunch",
          localDate: "2026-08-12",
          localTime: "13:00",
          timeZone: "Europe/Stockholm",
          dueAt: "2026-08-12T11:00:00.000Z",
          sourceMessageId: messageId,
          requiresAcknowledgment: true
        }
      })
    ).resolves.toMatchObject({ ok: true, code: "reminder_created" })
  })
})
