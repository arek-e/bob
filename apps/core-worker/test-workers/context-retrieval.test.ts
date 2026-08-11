import { applyD1Migrations, reset } from "cloudflare:test"
import { env } from "cloudflare:workers"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { createCoreDatabase } from "../src/database.ts"
import { makeContextStore } from "../src/modules/context/store.ts"
import { users } from "../src/modules/conversations/schema.ts"
import { factRevisions, facts, searchDocuments } from "../src/modules/memory/schema.ts"
import { createDataProtection } from "../src/modules/policy/data-protection.ts"
import { reminderOccurrences, reminders } from "../src/modules/reminders/schema.ts"
import { exercises, routines, routineSteps } from "../src/modules/training/schema.ts"
import { decodeTestMigrations } from "./migrations.ts"

declare global {
  namespace Cloudflare {
    interface Env {
      DB: D1Database
      TEST_MIGRATIONS: string
    }
  }
}

const ownerId = "00000000-0000-4000-8000-000000000301"
const channelId = "00000000-0000-4000-8000-000000000302"

function key(byte: number): string {
  let binary = ""
  for (const value of new Uint8Array(32).fill(byte)) binary += String.fromCharCode(value)
  return btoa(binary)
}

async function seedOwner() {
  const database = createCoreDatabase(env.DB)
  const protection = createDataProtection({ 1: key(31) }, 1, key(32))
  const wrapped = await protection.createWrappedDataKey()
  const at = "2026-08-11T10:00:00.000Z"
  await database.insert(users).values({
    id: ownerId,
    timeZone: "Europe/Stockholm",
    wrappedDataKey: wrapped.wrapped.ciphertext,
    wrappedDataKeyIv: wrapped.wrapped.iv,
    dataKeyVersion: wrapped.wrapped.version,
    createdAt: at,
    updatedAt: at
  })
  return { database, protection, ownerKey: wrapped.key }
}

function request(text: string) {
  return {
    ownerId,
    channelId,
    currentMessageId: "00000000-0000-4000-8000-000000000303",
    currentUserText: text,
    localTime: "2026-08-11T10:05:00.000Z",
    timeZone: "Europe/Stockholm"
  } as const
}

beforeEach(async () => {
  await applyD1Migrations(env.DB, decodeTestMigrations(env.TEST_MIGRATIONS))
})

afterEach(async () => {
  await reset()
})

describe("task-specific context retrieval", () => {
  it("excludes profile facts that are not safe for the message channel", async () => {
    const { database, protection, ownerKey } = await seedOwner()
    const createdAt = "2026-08-10T08:00:00.000Z"
    const canonical = await protection.encryptText(ownerKey, "My private access phrase is hidden.")
    const factId = "00000000-0000-4000-8000-000000000317"
    const revisionId = "00000000-0000-4000-8000-000000000318"
    await database.batch([
      database.insert(facts).values({
        id: factId,
        userId: ownerId,
        scope: "private",
        key: "access-phrase",
        currentRevisionId: revisionId,
        createdAt
      }),
      database.insert(factRevisions).values({
        id: revisionId,
        factId,
        valueJson: JSON.stringify("hidden"),
        canonicalTextCiphertext: canonical.ciphertext,
        canonicalTextIv: canonical.iv,
        dataKeyVersion: 1,
        assertionKind: "user_stated",
        originClass: "owner_input",
        observedAt: createdAt,
        extractionConfidence: 1000,
        importance: 1000,
        verificationStatus: "confirmed",
        sensitivity: "private",
        modelEligible: true,
        channelEligible: false,
        createdAt
      })
    ])

    const context = makeContextStore(database, protection, {})

    await expect(context.build(request("Hello"))).resolves.toEqual([])
  })

  it("retrieves only policy-cleared records and marks recalled text as data", async () => {
    const { database, protection } = await seedOwner()
    const createdAt = "2026-08-10T08:00:00.000Z"
    await database.insert(searchDocuments).values([
      {
        id: "00000000-0000-4000-8000-000000000311",
        userId: ownerId,
        sourceType: "fact_revision",
        sourceId: "00000000-0000-4000-8000-000000000312",
        text: "My mobility routine uses slow squats.",
        sourceLabel: "message 2026-08-10",
        occurredAt: createdAt,
        importance: 800,
        sensitivity: "normal",
        modelEligible: true,
        channelEligible: true,
        createdAt,
        updatedAt: createdAt
      },
      {
        id: "00000000-0000-4000-8000-000000000313",
        userId: ownerId,
        sourceType: "journal_summary",
        sourceId: "00000000-0000-4000-8000-000000000314",
        text: "Private mobility routine details.",
        sourceLabel: "journal 2026-08-10",
        occurredAt: createdAt,
        importance: 900,
        sensitivity: "private",
        modelEligible: false,
        channelEligible: false,
        createdAt,
        updatedAt: createdAt
      },
      {
        id: "00000000-0000-4000-8000-000000000315",
        userId: ownerId,
        sourceType: "fact_revision",
        sourceId: "00000000-0000-4000-8000-000000000316",
        text: "My private mobility plan uses a hidden exercise.",
        sourceLabel: "private memory 2026-08-10",
        occurredAt: createdAt,
        importance: 950,
        sensitivity: "private",
        modelEligible: true,
        channelEligible: false,
        createdAt,
        updatedAt: createdAt
      }
    ])

    const context = makeContextStore(database, protection, {})
    const items = await context.build(request("What is my mobility plan?"))

    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({
      kind: "fact",
      text: "My mobility routine uses slow squats.",
      instruction: false,
      conflict: false
    })
    expect(items[0]?.sources[0]).toMatchObject({
      sourceId: "00000000-0000-4000-8000-000000000312",
      sourceLabel: "message 2026-08-10"
    })
    expect(items.every((item) => !item.text.includes("hidden exercise"))).toBe(true)
  })

  it("adds normal active reminders but excludes private reminder text", async () => {
    const { database, protection, ownerKey } = await seedOwner()
    const normal = await protection.encryptText(ownerKey, "Bring training shoes")
    const privateText = await protection.encryptText(ownerKey, "Private appointment")
    const original = await protection.encryptText(ownerKey, "original")
    const sms = await protection.encryptText(ownerKey, "sms")
    const createdAt = "2026-08-11T10:00:00.000Z"
    const values = [
      {
        id: "00000000-0000-4000-8000-000000000321",
        sensitivity: "normal" as const,
        display: normal,
        due: "2026-08-12T16:00:00.000Z"
      },
      {
        id: "00000000-0000-4000-8000-000000000322",
        sensitivity: "private" as const,
        display: privateText,
        due: "2026-08-12T17:00:00.000Z"
      }
    ]
    for (const value of values) {
      await database.insert(reminders).values({
        id: value.id,
        userId: ownerId,
        sourceMessageId: "00000000-0000-4000-8000-000000000303",
        originalWordingCiphertext: original.ciphertext,
        originalWordingIv: original.iv,
        displayTextCiphertext: value.display.ciphertext,
        displayTextIv: value.display.iv,
        smsSafeTextCiphertext: sms.ciphertext,
        smsSafeTextIv: sms.iv,
        dataKeyVersion: 1,
        sensitivity: value.sensitivity,
        scheduleKind: "one_shot",
        localStartDate: "2026-08-12",
        localStartTime: "18:00",
        timeZone: "Europe/Stockholm",
        nextDueAt: value.due,
        quietHoursBehavior: "defer",
        requiresAcknowledgment: true,
        responseDeadlineMinutes: 120,
        repeatPolicy: "none",
        maxAttempts: 1,
        channelId,
        state: "active",
        scheduleRevision: 1,
        createdAt,
        updatedAt: createdAt
      })
      await database.insert(reminderOccurrences).values({
        id: value.id.replace(/32([12])$/u, "33$1"),
        reminderId: value.id,
        sequence: 1,
        intendedDueAt: value.due,
        localDisplayTime: "2026-08-12 18:00",
        idempotencyKey: `${value.id}:1`,
        state: "scheduled",
        createdAt,
        updatedAt: createdAt
      })
    }

    const context = makeContextStore(database, protection, {})
    const items = await context.build(request("Which reminders are due?"))
    const swedishItems = await context.build(request("Vilka påminnelser ska snart skickas?"))

    expect(items.some((item) => item.text.includes("Bring training shoes"))).toBe(true)
    expect(items.every((item) => !item.text.includes("Private appointment"))).toBe(true)
    expect(swedishItems).toEqual(items)
  })

  it("loads the same routine context for Swedish and English requests", async () => {
    const { database, protection } = await seedOwner()
    const createdAt = "2026-08-11T10:00:00.000Z"
    const exerciseId = "00000000-0000-4000-8000-000000000341"
    const routineId = "00000000-0000-4000-8000-000000000342"
    await database.batch([
      database.insert(exercises).values({
        id: exerciseId,
        userId: ownerId,
        name: "Leg press",
        createdAt
      }),
      database.insert(routines).values({
        id: routineId,
        userId: ownerId,
        name: "Full body",
        revision: 1,
        approvedAt: createdAt,
        approvalSourceType: "owner_ui",
        approvalSourceId: "approval",
        createdAt,
        updatedAt: createdAt
      }),
      database.insert(routineSteps).values({
        id: "00000000-0000-4000-8000-000000000343",
        routineId,
        exerciseId,
        position: 0,
        targetSets: 3,
        targetReps: 10,
        createdAt
      })
    ])

    const context = makeContextStore(database, protection, {})
    const english = await context.build(request("Show my training routine."))
    const swedish = await context.build(request("Visa min träningsrutin."))

    expect(swedish).toEqual(english)
    expect(swedish[0]?.text).toContain("Routine Full body")
  })
})
