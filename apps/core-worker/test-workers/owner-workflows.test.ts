import { applyD1Migrations, reset } from "cloudflare:test"
import { env } from "cloudflare:workers"
import { eq } from "drizzle-orm"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import type { CoreBindings } from "../src/bindings.ts"

import { createCoreDatabase } from "../src/database.ts"
import { handleHttp } from "../src/entrypoints/http.ts"
import { channels, messages, users } from "../src/modules/conversations/schema.ts"
import { journalEntries } from "../src/modules/journal/schema.ts"
import { makeJournalStore } from "../src/modules/journal/store.ts"
import {
  factEvidence,
  factRevisions,
  facts,
  memoryCandidates
} from "../src/modules/memory/schema.ts"
import { createDataProtection } from "../src/modules/policy/data-protection.ts"
import { reminderOccurrences } from "../src/modules/reminders/schema.ts"
import { makeReminderStore } from "../src/modules/reminders/store.ts"
import { makeRetrievalPipeline } from "../src/modules/retrieval/pipeline.ts"
import { searchDocuments } from "../src/modules/retrieval/schema.ts"
import { makeTrainingStore } from "../src/modules/training/store.ts"
import { makeTestEvidenceSources, makeTestMemoryStore } from "./memory-store-fixture.ts"
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
let ownerCookie: string | undefined

function key(byte: number): string {
  let binary = ""
  for (const value of new Uint8Array(32).fill(byte)) binary += String.fromCharCode(value)
  return btoa(binary)
}

function uuidSequence(start = 100): () => string {
  let next = start
  return () => `00000000-0000-4000-8000-${String(next++).padStart(12, "0")}`
}

async function seedOwner() {
  const database = createCoreDatabase(env.DB)
  const protection = createDataProtection({ 1: key(1) }, 1, key(2))
  const wrapped = await protection.createWrappedDataKey()
  const sender = await protection.encryptText(wrapped.key, "+46700000000")
  const destination = await protection.encryptText(wrapped.key, "+46711111111")
  const inbound = await protection.encryptText(wrapped.key, "Please remember my original note.")
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
      textCiphertext: inbound.ciphertext,
      textIv: inbound.iv,
      dataKeyVersion: wrapped.wrapped.version,
      occurredAt: at,
      createdAt: at
    })
  ])
  return { database, protection, ownerKey: wrapped.key }
}

async function ownerApi(path: string, init?: RequestInit): Promise<Response> {
  // SAFETY: This focused test double implements every platform member exercised by this test.
  const bindings = env as CoreBindings
  if (ownerCookie === undefined) {
    const setup = await handleHttp(
      new Request("https://core.example.invalid/setup/api", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: "unit-test-owner-password-2026" })
      }),
      bindings,
      async () => ({
        subject: "owner-subject",
        email: bindings.OWNER_ACCESS_EMAIL,
        audience: [bindings.SETUP_ACCESS_AUDIENCE]
      })
    )
    if (!setup.ok) throw new Error(`Owner setup failed with status ${setup.status}`)
    const setCookie = setup.headers.get("set-cookie")
    if (setCookie === null) throw new Error("Owner setup did not return a session cookie")
    ownerCookie = setCookie.split(";", 1)[0]
  }
  const headers = new Headers(init?.headers)
  headers.set("cookie", ownerCookie)
  return handleHttp(
    new Request(`https://core.example.invalid${path}`, { ...init, headers }),
    bindings
  )
}

beforeEach(async () => {
  ownerCookie = undefined
  await applyD1Migrations(env.DB, decodeTestMigrations(env.TEST_MIGRATIONS))
})

afterEach(async () => {
  await reset()
})

describe("unselected reminder records", () => {
  it("keeps stored records while the Core profile hides reminder routes", async () => {
    const { database, protection } = await seedOwner()
    const reminders = makeReminderStore(database, protection, {
      now: () => new Date("2026-08-11T10:05:00.000Z"),
      randomUuid: uuidSequence(50)
    })
    const first = await reminders.createOneShot(
      ownerId,
      channelId,
      "Remind me about my bag.",
      {
        displayText: "Pack my gym bag",
        smsSafeText: "Reminder: pack your gym bag.",
        localDate: "2099-08-12",
        localTime: "10:00",
        timeZone: "Europe/Stockholm",
        dueAt: "2099-08-12T08:00:00.000Z",
        sourceMessageId: messageId,
        requiresAcknowledgment: true
      },
      "reminder:create:first"
    )
    await expect(
      makeTestEvidenceSources(database, protection).verify({
        ownerId,
        sourceType: "reminder",
        sourceId: first.reminderId
      })
    ).resolves.toMatchObject({
      originClass: "system_record",
      confirmationAuthority: "completed_system_command",
      disclosure: "model_and_channel"
    })
    await database
      .update(reminderOccurrences)
      .set({ state: "awaiting_response" })
      .where(eq(reminderOccurrences.id, first.occurrenceId))

    const listed = await ownerApi("/api/reminders")
    expect(listed.status).toBe(404)
    await expect(reminders.list(ownerId)).resolves.toEqual([
      expect.objectContaining({
        id: first.reminderId,
        actionTargets: [
          expect.objectContaining({ occurrenceId: first.occurrenceId, state: "awaiting_response" })
        ]
      })
    ])
  })
})

describe("owner memory review", () => {
  it("promotes an owner-reviewed message candidate into sourced recall", async () => {
    const { database, protection } = await seedOwner()
    const memory = makeTestMemoryStore(database, protection, {
      now: () => new Date("2026-08-11T10:05:00.000Z"),
      randomUuid: uuidSequence(75)
    })
    const retrieval = makeRetrievalPipeline(database)
    const proposal = await memory.propose(
      {
        ownerId,
        scope: "preferences",
        key: "training_time",
        value: "morning",
        canonicalText: "I prefer to train in the morning.",
        assertionKind: "user_stated",
        originClass: "owner_input",
        sourceType: "message",
        sourceId: messageId,
        extractionConfidence: 0.9,
        importance: 0.8,
        explicitRemember: true,
        authority: "agent"
      },
      "memory:promotion:propose"
    )

    expect(proposal.status).toBe("proposed")
    await expect(
      retrieval.retrieve({
        ownerId,
        query: "morning",
        channel: false,
        referenceTime: "2026-08-11T10:05:00.000Z",
        timeZone: "Europe/Stockholm"
      })
    ).resolves.toMatchObject({ status: "abstain", reason: "no_candidates" })

    const confirmed = await ownerApi(`/api/memory/candidates/${proposal.candidateId}/confirm`, {
      method: "POST",
      headers: { "idempotency-key": "memory:promotion:confirm" },
      body: "{}"
    })
    expect(confirmed.status).toBe(200)
    // SAFETY: This controlled test fixture matches the asserted contract used by this test.
    const { revisionId } = (await confirmed.json()) as { revisionId: string }

    const [revision] = await database
      .select()
      .from(factRevisions)
      .where(eq(factRevisions.id, revisionId))
    const evidence = await database
      .select()
      .from(factEvidence)
      .where(eq(factEvidence.revisionId, revisionId))
    expect(revision).toMatchObject({
      originClass: "owner_input",
      verificationStatus: "confirmed",
      sensitivity: "normal",
      modelEligible: true,
      channelEligible: true
    })
    expect(evidence).toEqual([
      expect.objectContaining({
        sourceType: "message",
        sourceId: messageId,
        sourceLabel: "Owner message linked on 11 Aug 2026",
        sourceOccurredAt: "2026-08-11T10:00:00.000Z"
      })
    ])
    expect(evidence[0]?.excerptHash).toBe(
      await protection.contentHash("Please remember my original note.")
    )
    for (const channel of [false, true]) {
      await expect(
        retrieval.retrieve({
          ownerId,
          query: "morning",
          channel,
          referenceTime: "2099-08-11T10:05:00.000Z",
          timeZone: "Europe/Stockholm"
        })
      ).resolves.toMatchObject({
        status: "supported",
        items: [
          expect.objectContaining({
            sourceId: revisionId,
            text: "I prefer to train in the morning.",
            sourceLabel: "Owner message linked on 11 Aug 2026"
          })
        ]
      })
    }
  })

  it("keeps superseded fact projections available only for historical retrieval", async () => {
    const { database, protection, ownerKey } = await seedOwner()
    let clock = new Date("2026-08-11T10:05:00.000Z")
    const memory = makeTestMemoryStore(database, protection, {
      now: () => clock,
      randomUuid: uuidSequence(500)
    })
    const first = await memory.propose(
      {
        ownerId,
        scope: "preferences",
        key: "work_time",
        value: "morning",
        canonicalText: "I prefer focused work in the morning.",
        sourceType: "message",
        sourceId: messageId,
        extractionConfidence: 1,
        importance: 0.8,
        explicitRemember: true,
        authority: "agent"
      },
      "memory:history:first:propose"
    )
    const firstRevisionId = await memory.confirm(
      ownerId,
      first.candidateId,
      "owner_ui",
      "memory:history:first:confirm"
    )

    const secondMessageId = "00000000-0000-4000-8000-000000000590"
    const secondText = await protection.encryptText(ownerKey, "I now prefer afternoon focus.")
    await database.insert(messages).values({
      id: secondMessageId,
      userId: ownerId,
      channelId,
      direction: "inbound",
      textCiphertext: secondText.ciphertext,
      textIv: secondText.iv,
      dataKeyVersion: 1,
      occurredAt: "2026-08-13T10:00:00.000Z",
      createdAt: "2026-08-13T10:00:00.000Z"
    })
    clock = new Date("2026-08-13T10:05:00.000Z")
    const second = await memory.propose(
      {
        ownerId,
        scope: "preferences",
        key: "work_time",
        value: "afternoon",
        canonicalText: "I prefer focused work in the afternoon.",
        sourceType: "message",
        sourceId: secondMessageId,
        extractionConfidence: 1,
        importance: 0.8,
        explicitRemember: true,
        authority: "agent"
      },
      "memory:history:second:propose"
    )
    const secondRevisionId = await memory.confirm(
      ownerId,
      second.candidateId,
      "owner_ui",
      "memory:history:second:confirm"
    )
    const retrieval = makeRetrievalPipeline(database)

    await expect(
      retrieval.retrieve({
        ownerId,
        query: "focused work",
        channel: true,
        referenceTime: "2026-08-14T10:00:00.000Z",
        timeZone: "Europe/Stockholm"
      })
    ).resolves.toMatchObject({
      status: "supported",
      items: [{ sourceId: secondRevisionId, text: expect.stringContaining("afternoon") }]
    })
    await expect(
      retrieval.retrieve({
        ownerId,
        query: "focused work as of 2026-08-11",
        channel: true,
        referenceTime: "2026-08-14T10:00:00.000Z",
        timeZone: "Europe/Stockholm"
      })
    ).resolves.toMatchObject({
      status: "supported",
      items: [{ sourceId: firstRevisionId, text: expect.stringContaining("morning") }]
    })
    const indexed = await database.select().from(searchDocuments)
    expect(indexed).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sourceId: firstRevisionId,
          deletedAt: null,
          validTo: clock.toISOString()
        }),
        expect.objectContaining({ sourceId: secondRevisionId, deletedAt: null, validTo: null })
      ])
    )
  })

  it("binds a correction to its owner source and rejects the old proposal", async () => {
    const { database, protection } = await seedOwner()
    const memory = makeTestMemoryStore(database, protection, {
      now: () => new Date("2026-08-11T10:05:00.000Z"),
      randomUuid: uuidSequence(100)
    })
    const proposal = await memory.propose(
      {
        ownerId,
        scope: "profile",
        key: "training_day",
        value: "Monday",
        canonicalText: "My training day is Monday.",
        assertionKind: "user_stated",
        originClass: "owner_input",
        sourceType: "message",
        sourceId: messageId,
        extractionConfidence: 0.8,
        importance: 0.7,
        explicitRemember: false,
        authority: "agent"
      },
      "memory:propose:one"
    )

    await expect(
      memory.correct(
        "00000000-0000-4000-8000-000000000099",
        proposal.candidateId,
        "Wrong owner correction.",
        "memory:correct:wrong-owner"
      )
    ).rejects.toThrow("Memory candidate not found")

    const correction = await ownerApi(`/api/memory/candidates/${proposal.candidateId}/correct`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": "memory:correct:one"
      },
      body: JSON.stringify({ canonicalText: "My training day is Tuesday." })
    })
    expect(correction.status).toBe(200)
    // SAFETY: This controlled test fixture matches the asserted contract used by this test.
    const { candidateId: replacementId } = (await correction.json()) as { candidateId: string }
    await expect(
      memory.correct(
        ownerId,
        proposal.candidateId,
        "This later retry must not replace the correction.",
        "memory:correct:one"
      )
    ).resolves.toBe(replacementId)

    const rows = await database
      .select({ id: memoryCandidates.id, status: memoryCandidates.status })
      .from(memoryCandidates)
    expect(rows).toEqual(
      expect.arrayContaining([
        { id: proposal.candidateId, status: "rejected" },
        { id: replacementId, status: "proposed" }
      ])
    )
    await expect(memory.listCandidates(ownerId)).resolves.toEqual([
      expect.objectContaining({
        id: replacementId,
        canonicalText: "My training day is Tuesday.",
        sourceLabel: expect.stringMatching(/^Owner message linked on \d{1,2} [A-Z][a-z]{2} \d{4}$/u)
      })
    ])
    await expect(
      memory.confirm(ownerId, replacementId, "owner_ui", "memory:confirm:replacement")
    ).resolves.toMatch(/^[0-9a-f-]{36}$/u)
  })

  it("fails closed when source evidence changes before confirmation", async () => {
    const { database, protection, ownerKey } = await seedOwner()
    const memory = makeTestMemoryStore(database, protection, { randomUuid: uuidSequence(180) })
    const proposal = await memory.propose(
      {
        ownerId,
        scope: "profile",
        key: "stable_source",
        value: "original",
        canonicalText: "The source says original.",
        sourceType: "message",
        sourceId: messageId,
        extractionConfidence: 1,
        importance: 0.5,
        explicitRemember: false,
        authority: "agent"
      },
      "memory:source-change:propose"
    )
    const changed = await protection.encryptText(ownerKey, "Changed source text.")
    await database
      .update(messages)
      .set({ textCiphertext: changed.ciphertext, textIv: changed.iv })
      .where(eq(messages.id, messageId))

    await expect(
      memory.confirm(ownerId, proposal.candidateId, "owner_ui", "memory:source-change:confirm")
    ).rejects.toThrow("changed")
  })

  it("rejects only an owner candidate and keeps the action idempotent", async () => {
    const { database, protection } = await seedOwner()
    const memory = makeTestMemoryStore(database, protection, { randomUuid: uuidSequence(200) })
    const proposal = await memory.propose(
      {
        ownerId,
        scope: "profile",
        key: "nickname",
        value: "Al",
        canonicalText: "My nickname is Al.",
        assertionKind: "user_stated",
        originClass: "owner_input",
        sourceType: "message",
        sourceId: messageId,
        extractionConfidence: 0.8,
        importance: 0.5,
        explicitRemember: false,
        authority: "agent"
      },
      "memory:propose:two"
    )

    const rejected = await ownerApi(`/api/memory/candidates/${proposal.candidateId}/reject`, {
      method: "POST",
      headers: { "idempotency-key": "memory:reject:one" },
      body: "{}"
    })
    expect(rejected.status).toBe(200)
    await expect(
      memory.reject(ownerId, proposal.candidateId, "memory:reject:one")
    ).resolves.toBeUndefined()
    await expect(memory.listCandidates(ownerId)).resolves.toEqual([])
    const [candidate] = await database
      .select({ status: memoryCandidates.status })
      .from(memoryCandidates)
      .where(eq(memoryCandidates.id, proposal.candidateId))
    expect(candidate?.status).toBe("rejected")
  })
})

describe("owner journal changes", () => {
  it("edits encrypted text and maintains a private approved-summary projection", async () => {
    const { database, protection } = await seedOwner()
    const journal = makeJournalStore(database, protection, {
      now: () => new Date("2026-08-11T10:10:00.000Z"),
      randomUuid: uuidSequence(300)
    })
    const handoff = await journal.createHandoff(ownerId, 60_000, "journal:handoff:one")
    const entryId = await journal.createEntry(
      {
        ownerId,
        handoffId: handoff.id,
        text: "Original private text",
        tags: ["day"],
        approvedSummary: "Original note"
      },
      "journal:create:one"
    )
    const memory = makeTestMemoryStore(database, protection, { randomUuid: uuidSequence(350) })
    const proposal = await memory.propose(
      {
        ownerId,
        scope: "journal",
        key: "day_note",
        value: "Original note",
        canonicalText: "The original journal note was saved.",
        assertionKind: "user_stated",
        originClass: "owner_input",
        sourceType: "journal_summary",
        sourceId: entryId,
        extractionConfidence: 0.8,
        importance: 0.5,
        explicitRemember: false,
        authority: "agent"
      },
      "journal:memory:propose"
    )
    const revisionId = await memory.confirm(
      ownerId,
      proposal.candidateId,
      "owner_ui",
      "journal:memory:confirm"
    )
    const [privateRevision] = await database
      .select({
        sensitivity: factRevisions.sensitivity,
        modelEligible: factRevisions.modelEligible,
        channelEligible: factRevisions.channelEligible
      })
      .from(factRevisions)
      .where(eq(factRevisions.id, revisionId))
    const [privateEvidence] = await database
      .select()
      .from(factEvidence)
      .where(eq(factEvidence.revisionId, revisionId))
    expect(privateRevision).toEqual({
      sensitivity: "private",
      modelEligible: false,
      channelEligible: false
    })
    expect(privateEvidence?.excerptHash).toBe(await protection.contentHash("Original note"))

    await expect(
      journal.updateEntry(
        "00000000-0000-4000-8000-000000000099",
        entryId,
        { text: "Wrong owner edit", tags: [] },
        "journal:update:wrong-owner"
      )
    ).rejects.toThrow("Journal entry not found")

    const updated = await ownerApi(`/api/journal/${entryId}`, {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        "idempotency-key": "journal:update:one"
      },
      body: JSON.stringify({
        text: "Corrected private text",
        tags: ["day", "training"],
        approvedSummary: "I trained today."
      })
    })
    expect(updated.status).toBe(404)
    await journal.updateEntry(
      ownerId,
      entryId,
      {
        text: "Corrected private text",
        tags: ["day", "training"],
        approvedSummary: "I trained today."
      },
      "journal:update:one"
    )

    await expect(journal.readEntry(ownerId, entryId)).resolves.toEqual({
      id: entryId,
      createdAt: "2026-08-11T10:10:00.000Z",
      text: "Corrected private text",
      tags: ["day", "training"],
      approvedSummary: "I trained today."
    })
    const [stored] = await database
      .select({ ciphertext: journalEntries.textCiphertext })
      .from(journalEntries)
      .where(eq(journalEntries.id, entryId))
    expect(stored?.ciphertext).not.toContain("Corrected private text")
    const [projection] = await database
      .select({
        text: searchDocuments.text,
        memoryClass: searchDocuments.memoryClass,
        modelEligible: searchDocuments.modelEligible,
        channelEligible: searchDocuments.channelEligible
      })
      .from(searchDocuments)
      .where(eq(searchDocuments.sourceId, entryId))
    expect(projection).toEqual({
      text: "I trained today.",
      memoryClass: "owner_episode",
      modelEligible: false,
      channelEligible: false
    })
    const [fact] = await database.select({ currentRevisionId: facts.currentRevisionId }).from(facts)
    expect(fact?.currentRevisionId).toBeNull()
    const [revision] = await database
      .select({ status: factRevisions.verificationStatus })
      .from(factRevisions)
      .where(eq(factRevisions.id, revisionId))
    expect(revision?.status).toBe("disputed")
    await expect(
      database.select().from(factEvidence).where(eq(factEvidence.revisionId, revisionId))
    ).resolves.toEqual([])
  })
})

describe("owner training overview", () => {
  it("returns owner-scoped catalog matches, the active workout, and history", async () => {
    const { database, protection } = await seedOwner()
    const training = makeTrainingStore(database, {
      now: () => new Date("2026-08-11T10:15:00.000Z"),
      randomUuid: uuidSequence(400)
    })
    const gymId = await training.createGym(ownerId, "Stockholm Strength", "gym:create:one")
    const exerciseId = await training.createExercise(
      ownerId,
      "Chest press",
      "Keep your back supported.",
      "exercise:create:one"
    )
    const equipmentId = await training.addEquipment(
      ownerId,
      gymId,
      "Chest press machine",
      "Machine 12",
      "equipment:create:one"
    )
    await training.mapEquipment(ownerId, equipmentId, exerciseId, "equipment:map:one")
    const routineId = await training.saveRoutine(
      {
        ownerId,
        name: "Push day",
        approvalEvidence: { sourceType: "owner_message", sourceId: messageId },
        steps: [{ exerciseId, targetSets: 3, targetReps: 8 }]
      },
      "routine:create:one"
    )
    const completedSessionId = await training.startWorkout(
      ownerId,
      routineId,
      gymId,
      "workout:start:one"
    )
    const routine = await training.getRoutine(ownerId, routineId)
    await training.logSet(
      ownerId,
      {
        sessionId: completedSessionId,
        routineStepId: routine!.steps[0]!.id,
        equipmentId,
        sequence: 1,
        repetitions: 8,
        weightGrams: 30_000
      },
      "workout:set:one"
    )
    await training.finishWorkout(ownerId, completedSessionId, "workout:finish:one")
    const activeSessionId = await training.startWorkout(
      ownerId,
      routineId,
      gymId,
      "workout:start:two"
    )
    const evidence = makeTestEvidenceSources(database, protection)
    await expect(
      evidence.verify({ ownerId, sourceType: "routine", sourceId: routineId })
    ).resolves.toMatchObject({
      originClass: "system_record",
      confirmationAuthority: "completed_system_command"
    })
    await expect(
      evidence.verify({ ownerId, sourceType: "workout_session", sourceId: completedSessionId })
    ).resolves.toMatchObject({ originClass: "system_record" })
    await expect(
      evidence.verify({ ownerId, sourceType: "workout_session", sourceId: activeSessionId })
    ).rejects.toThrow("evidence")

    const overview = await training.overview(ownerId, "press")
    expect(overview.gyms).toEqual([
      expect.objectContaining({
        id: gymId,
        equipment: [expect.objectContaining({ id: equipmentId, exerciseIds: [exerciseId] })]
      })
    ])
    expect(overview.exercises).toEqual([expect.objectContaining({ id: exerciseId })])
    expect(overview.routines).toEqual([
      expect.objectContaining({
        id: routineId,
        steps: [expect.objectContaining({ exerciseId })]
      })
    ])
    expect(overview.activeWorkout).toEqual(
      expect.objectContaining({ id: activeSessionId, status: "active", sets: [] })
    )
    expect(overview.history).toEqual([
      expect.objectContaining({
        id: completedSessionId,
        routineName: "Push day",
        status: "completed"
      })
    ])
    await expect(
      training.overview("00000000-0000-4000-8000-000000000099", "press")
    ).resolves.toMatchObject({ gyms: [], exercises: [], routines: [], history: [] })

    const response = await ownerApi("/api/training/overview?q=press")
    expect(response.status).toBe(404)
    await expect(training.overview(ownerId, "press")).resolves.toMatchObject({
      gyms: [{ id: gymId }],
      exercises: [{ id: exerciseId }],
      routines: [{ id: routineId }],
      activeWorkout: { id: activeSessionId },
      history: [{ id: completedSessionId, status: "completed" }]
    })
  })
})
