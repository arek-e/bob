import { applyD1Migrations, reset } from "cloudflare:test"
import { env } from "cloudflare:workers"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { createCoreDatabase } from "../src/database.ts"
import { makeAgentRunStore } from "../src/modules/conversations/run-store.ts"
import {
  agentRunAttempts,
  agentRuns,
  channels,
  conversationTurns,
  inboundEvents,
  messages,
  users
} from "../src/modules/conversations/schema.ts"
import { makeConversationTurnStore } from "../src/modules/conversations/turn-store.ts"
import { createDataProtection } from "../src/modules/policy/data-protection.ts"
import { decodeTestMigrations } from "./migrations.ts"

declare global {
  namespace Cloudflare {
    interface Env {
      DB: D1Database
      TEST_MIGRATIONS: string
    }
  }
}

const ownerId = "00000000-0000-4000-8000-000000000401"
const channelId = "00000000-0000-4000-8000-000000000402"
const firstMessageId = "00000000-0000-4000-8000-000000000403"
const firstEventId = "00000000-0000-4000-8000-000000000404"

function key(byte: number): string {
  let binary = ""
  for (const value of new Uint8Array(32).fill(byte)) binary += String.fromCharCode(value)
  return btoa(binary)
}

function uuidSequence(start = 500): () => string {
  let next = start
  return () => `00000000-0000-4000-8000-${String(next++).padStart(12, "0")}`
}

async function seedInbound() {
  const database = createCoreDatabase(env.DB)
  const protection = createDataProtection({ 1: key(41) }, 1, key(42))
  const wrapped = await protection.createWrappedDataKey()
  const sender = await protection.encryptText(wrapped.key, "+46700000000")
  const destination = await protection.encryptText(wrapped.key, "+46711111111")
  const text = await protection.encryptText(wrapped.key, "Lost my reminders")
  const at = "2026-08-12T08:00:00.000Z"
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
      id: firstMessageId,
      userId: ownerId,
      channelId,
      direction: "inbound",
      textCiphertext: text.ciphertext,
      textIv: text.iv,
      dataKeyVersion: wrapped.wrapped.version,
      occurredAt: at,
      createdAt: at
    }),
    database.insert(inboundEvents).values({
      id: firstEventId,
      userId: ownerId,
      channelId,
      messageId: firstMessageId,
      accountId: "account",
      lineId: "line",
      providerMessageHandle: "provider-first",
      service: "imessage",
      isGroup: false,
      correlationId: "00000000-0000-4000-8000-000000000405",
      createdAt: at
    })
  ])
  return { database, protection, ownerKey: wrapped.key }
}

async function addInbound(
  database: ReturnType<typeof createCoreDatabase>,
  protection: ReturnType<typeof createDataProtection>,
  ownerKey: CryptoKey,
  input: {
    readonly eventId: string
    readonly messageId: string
    readonly text: string
    readonly at: string
  }
) {
  const encrypted = await protection.encryptText(ownerKey, input.text)
  await database.batch([
    database.insert(messages).values({
      id: input.messageId,
      userId: ownerId,
      channelId,
      direction: "inbound",
      textCiphertext: encrypted.ciphertext,
      textIv: encrypted.iv,
      dataKeyVersion: 1,
      occurredAt: input.at,
      createdAt: input.at
    }),
    database.insert(inboundEvents).values({
      id: input.eventId,
      userId: ownerId,
      channelId,
      messageId: input.messageId,
      accountId: "account",
      lineId: "line",
      providerMessageHandle: `provider-${input.eventId}`,
      service: "imessage",
      isGroup: false,
      correlationId: input.eventId,
      createdAt: input.at
    })
  ])
}

async function insertExecutingConversationRun(
  database: ReturnType<typeof createCoreDatabase>,
  input: {
    readonly turnId: string
    readonly runId: string
    readonly attemptId: string
    readonly revision: number
    readonly at: string
  }
) {
  await database.batch([
    database.insert(agentRuns).values({
      id: input.runId,
      userId: ownerId,
      inboundEventId: firstEventId,
      conversationTurnId: input.turnId,
      conversationTurnRevision: input.revision,
      targetMessageId: firstMessageId,
      correlationId: "00000000-0000-4000-8000-000000000405",
      inputSnapshotJson: "{}",
      inputHash: "hash",
      status: "executing",
      model: "gpt-test",
      activeAttemptId: input.attemptId,
      createdAt: input.at
    }),
    database.insert(agentRunAttempts).values({
      id: input.attemptId,
      runId: input.runId,
      attemptNumber: 1,
      status: "executing",
      startedAt: input.at
    })
  ])
}

beforeEach(async () => {
  await applyD1Migrations(env.DB, decodeTestMigrations(env.TEST_MIGRATIONS))
})

afterEach(async () => {
  await reset()
})

describe("durable conversation turns", () => {
  it("offers the first inbound as revision one with a bounded collection window", async () => {
    const { database, protection } = await seedInbound()
    const turns = makeConversationTurnStore(database, protection, {
      ownerId,
      now: () => new Date("2026-08-12T08:00:00.000Z"),
      randomUuid: uuidSequence()
    })

    await expect(turns.offer(firstEventId)).resolves.toEqual({
      turnId: "00000000-0000-4000-8000-000000000500",
      revision: 1,
      status: "collecting",
      quietUntil: "2026-08-12T08:00:01.500Z",
      appended: true
    })
  })

  it("atomically starts a fresh reflection revision after a completed mutation", async () => {
    const { database, protection } = await seedInbound()
    let at = new Date("2026-08-12T08:00:00.000Z")
    const turns = makeConversationTurnStore(database, protection, {
      ownerId,
      now: () => at,
      randomUuid: uuidSequence()
    })
    const offered = await turns.offer(firstEventId)
    at = new Date("2026-08-12T08:00:02.000Z")
    const claimed = await turns.claimReady(offered.turnId)
    expect(claimed?.revision).toBe(1)
    const runId = "00000000-0000-4000-8000-000000000520"
    const attemptId = "00000000-0000-4000-8000-000000000521"
    expect(await turns.markRunning(offered.turnId, 1, runId)).toBe(true)
    await insertExecutingConversationRun(database, {
      turnId: offered.turnId,
      runId,
      attemptId,
      revision: 1,
      at: at.toISOString()
    })
    const runs = makeAgentRunStore(database, protection, { now: () => at })

    await expect(
      runs.completeForReflection(
        {
          protocolVersion: 1,
          runId,
          correlationId: "00000000-0000-4000-8000-000000000405",
          status: "failed",
          errorCode: "provider",
          model: "gpt-test",
          durationMs: 100,
          inputTokens: 10,
          outputTokens: 2,
          toolCalls: 1
        },
        "00000000-0000-4000-8000-000000000529",
        { conversationTurnId: offered.turnId, conversationTurnRevision: 1 }
      )
    ).resolves.toEqual({ status: "lost" })
    await expect(database.select().from(agentRuns)).resolves.toEqual([
      expect.objectContaining({ status: "executing", activeAttemptId: attemptId })
    ])
    await expect(database.select().from(conversationTurns)).resolves.toEqual([
      expect.objectContaining({ status: "running", revision: 1, activeRunId: runId })
    ])

    await expect(
      runs.completeForReflection(
        {
          protocolVersion: 1,
          runId,
          correlationId: "00000000-0000-4000-8000-000000000405",
          status: "failed",
          errorCode: "provider",
          model: "gpt-test",
          durationMs: 100,
          inputTokens: 10,
          outputTokens: 2,
          toolCalls: 1
        },
        attemptId,
        { conversationTurnId: offered.turnId, conversationTurnRevision: 1 }
      )
    ).resolves.toEqual({
      status: "released",
      revision: 2,
      wakeAt: "2026-08-12T08:00:02.000Z"
    })
    await expect(
      runs.completeForReflection(
        {
          protocolVersion: 1,
          runId,
          correlationId: "00000000-0000-4000-8000-000000000405",
          status: "failed",
          errorCode: "provider",
          model: "gpt-test",
          durationMs: 100,
          inputTokens: 10,
          outputTokens: 2,
          toolCalls: 1
        },
        attemptId,
        { conversationTurnId: offered.turnId, conversationTurnRevision: 1 }
      )
    ).resolves.toEqual({ status: "lost" })

    const [storedRun] = await database.select().from(agentRuns)
    const [storedAttempt] = await database.select().from(agentRunAttempts)
    const [storedTurn] = await database.select().from(conversationTurns)
    expect(storedRun).toMatchObject({ status: "superseded", activeAttemptId: null })
    expect(storedAttempt).toMatchObject({ status: "superseded" })
    expect(storedTurn).toMatchObject({
      status: "collecting",
      revision: 2,
      activeRunId: null,
      claimedRevision: null
    })
    await expect(turns.claimReady(offered.turnId)).resolves.toMatchObject({
      revision: 2,
      latest: { eventId: firstEventId, messageId: firstMessageId },
      messages: [{ eventId: firstEventId, messageId: firstMessageId }]
    })
  })

  it("releases an existing newer user revision without adding another revision", async () => {
    const { database, protection, ownerKey } = await seedInbound()
    let at = new Date("2026-08-12T08:00:00.000Z")
    const turns = makeConversationTurnStore(database, protection, {
      ownerId,
      now: () => at,
      randomUuid: uuidSequence()
    })
    const offered = await turns.offer(firstEventId)
    at = new Date("2026-08-12T08:00:02.000Z")
    await turns.claimReady(offered.turnId)
    const runId = "00000000-0000-4000-8000-000000000524"
    const attemptId = "00000000-0000-4000-8000-000000000525"
    expect(await turns.markRunning(offered.turnId, 1, runId)).toBe(true)
    await insertExecutingConversationRun(database, {
      turnId: offered.turnId,
      runId,
      attemptId,
      revision: 1,
      at: at.toISOString()
    })
    const secondEventId = "00000000-0000-4000-8000-000000000526"
    const secondMessageId = "00000000-0000-4000-8000-000000000527"
    await addInbound(database, protection, ownerKey, {
      eventId: secondEventId,
      messageId: secondMessageId,
      text: "Actually at eight",
      at: "2026-08-12T08:00:02.100Z"
    })
    at = new Date("2026-08-12T08:00:02.100Z")
    await expect(turns.offer(secondEventId)).resolves.toMatchObject({
      turnId: offered.turnId,
      revision: 2,
      status: "settling",
      quietUntil: "2026-08-12T08:00:03.600Z"
    })
    const runs = makeAgentRunStore(database, protection, { now: () => at })

    await expect(
      runs.completeForReflection(
        {
          protocolVersion: 1,
          runId,
          correlationId: "00000000-0000-4000-8000-000000000405",
          status: "cancelled",
          errorCode: "cancelled",
          model: "gpt-test",
          durationMs: 100,
          inputTokens: 10,
          outputTokens: 2,
          toolCalls: 1
        },
        attemptId,
        { conversationTurnId: offered.turnId, conversationTurnRevision: 1 }
      )
    ).resolves.toEqual({
      status: "released",
      revision: 2,
      wakeAt: "2026-08-12T08:00:03.600Z"
    })

    at = new Date("2026-08-12T08:00:03.599Z")
    await expect(turns.claimReady(offered.turnId)).resolves.toBeUndefined()
    at = new Date("2026-08-12T08:00:03.600Z")
    await expect(turns.claimReady(offered.turnId)).resolves.toMatchObject({
      revision: 2,
      latest: { eventId: secondEventId, messageId: secondMessageId },
      messages: [
        { eventId: firstEventId, messageId: firstMessageId },
        { eventId: secondEventId, messageId: secondMessageId }
      ]
    })
  })

  it("keeps reflection settling until the active mutation lease expires", async () => {
    const { database, protection, ownerKey } = await seedInbound()
    let at = new Date("2026-08-12T08:00:00.000Z")
    const turns = makeConversationTurnStore(database, protection, {
      ownerId,
      now: () => at,
      randomUuid: uuidSequence()
    })
    const offered = await turns.offer(firstEventId)
    at = new Date("2026-08-12T08:00:02.000Z")
    await turns.claimReady(offered.turnId)
    const runId = "00000000-0000-4000-8000-000000000522"
    const attemptId = "00000000-0000-4000-8000-000000000523"
    expect(await turns.markRunning(offered.turnId, 1, runId)).toBe(true)
    await insertExecutingConversationRun(database, {
      turnId: offered.turnId,
      runId,
      attemptId,
      revision: 1,
      at: at.toISOString()
    })
    const secondEventId = "00000000-0000-4000-8000-000000000528"
    const secondMessageId = "00000000-0000-4000-8000-000000000529"
    await addInbound(database, protection, ownerKey, {
      eventId: secondEventId,
      messageId: secondMessageId,
      text: "Actually at eight",
      at: "2026-08-12T08:00:02.100Z"
    })
    at = new Date("2026-08-12T08:00:02.100Z")
    await expect(turns.offer(secondEventId)).resolves.toMatchObject({
      revision: 2,
      status: "settling",
      activeRunId: runId
    })
    const runs = makeAgentRunStore(database, protection, { now: () => at })

    await expect(
      runs.completeForReflection(
        {
          protocolVersion: 1,
          runId,
          correlationId: "00000000-0000-4000-8000-000000000405",
          status: "failed",
          errorCode: "provider",
          model: "gpt-test",
          durationMs: 100,
          inputTokens: 10,
          outputTokens: 2,
          toolCalls: 1
        },
        attemptId,
        {
          conversationTurnId: offered.turnId,
          conversationTurnRevision: 1,
          settleUntil: "2026-08-12T08:01:00.000Z"
        }
      )
    ).resolves.toEqual({
      status: "settling",
      revision: 2,
      wakeAt: "2026-08-12T08:01:00.000Z"
    })

    at = new Date("2026-08-12T08:00:59.999Z")
    await expect(turns.claimReady(offered.turnId)).resolves.toBeUndefined()
    at = new Date("2026-08-12T08:01:00.000Z")
    await expect(turns.claimReady(offered.turnId)).resolves.toMatchObject({
      revision: 2,
      latest: { eventId: secondEventId, messageId: secondMessageId }
    })
  })

  it("appends a later inbound to the open turn and moves the response target", async () => {
    const { database, protection, ownerKey } = await seedInbound()
    let at = new Date("2026-08-12T08:00:00.000Z")
    const turns = makeConversationTurnStore(database, protection, {
      ownerId,
      now: () => at,
      randomUuid: uuidSequence()
    })
    const first = await turns.offer(firstEventId)
    const secondEventId = "00000000-0000-4000-8000-000000000406"
    const secondMessageId = "00000000-0000-4000-8000-000000000407"
    await addInbound(database, protection, ownerKey, {
      eventId: secondEventId,
      messageId: secondMessageId,
      text: "List",
      at: "2026-08-12T08:00:01.000Z"
    })
    at = new Date("2026-08-12T08:00:01.000Z")

    await expect(turns.offer(secondEventId)).resolves.toEqual({
      turnId: first.turnId,
      revision: 2,
      status: "collecting",
      quietUntil: "2026-08-12T08:00:02.500Z",
      appended: true
    })
  })

  it("caps a continuous message burst at five seconds from the first inbound", async () => {
    const { database, protection, ownerKey } = await seedInbound()
    let at = new Date("2026-08-12T08:00:00.000Z")
    const turns = makeConversationTurnStore(database, protection, {
      ownerId,
      now: () => at,
      randomUuid: uuidSequence()
    })
    const first = await turns.offer(firstEventId)
    const messagesInBurst = [
      {
        eventId: "00000000-0000-4000-8000-000000000434",
        messageId: "00000000-0000-4000-8000-000000000435",
        at: "2026-08-12T08:00:01.000Z"
      },
      {
        eventId: "00000000-0000-4000-8000-000000000436",
        messageId: "00000000-0000-4000-8000-000000000437",
        at: "2026-08-12T08:00:02.500Z"
      },
      {
        eventId: "00000000-0000-4000-8000-000000000438",
        messageId: "00000000-0000-4000-8000-000000000439",
        at: "2026-08-12T08:00:04.500Z"
      }
    ]
    let lastOffer = first
    for (const [index, inbound] of messagesInBurst.entries()) {
      await addInbound(database, protection, ownerKey, {
        ...inbound,
        text: `Burst message ${index + 2}`
      })
      at = new Date(inbound.at)
      lastOffer = await turns.offer(inbound.eventId)
    }

    expect(lastOffer).toMatchObject({
      revision: 4,
      quietUntil: "2026-08-12T08:00:05.000Z"
    })
    at = new Date("2026-08-12T08:00:04.999Z")
    await expect(turns.claimReady(first.turnId, 90_000)).resolves.toBeUndefined()
    at = new Date("2026-08-12T08:00:05.000Z")
    await expect(turns.claimReady(first.turnId, 90_000)).resolves.toMatchObject({
      revision: 4,
      latest: { eventId: messagesInBurst[2]!.eventId }
    })
  })

  it("starts a follow-up turn when delivery closes the selected turn before append", async () => {
    const { database, protection, ownerKey } = await seedInbound()
    let at = new Date("2026-08-12T08:00:00.000Z")
    const turns = makeConversationTurnStore(database, protection, {
      ownerId,
      now: () => at,
      randomUuid: uuidSequence()
    })
    const first = await turns.offer(firstEventId)
    const secondEventId = "00000000-0000-4000-8000-000000000420"
    const secondMessageId = "00000000-0000-4000-8000-000000000421"
    await addInbound(database, protection, ownerKey, {
      eventId: secondEventId,
      messageId: secondMessageId,
      text: "One more thing",
      at: "2026-08-12T08:00:01.000Z"
    })
    at = new Date("2026-08-12T08:00:01.000Z")
    let batchCount = 0
    const racedBinding = new Proxy(env.DB, {
      get(target, property) {
        if (property === "batch") {
          return async (statements: D1PreparedStatement[]) => {
            batchCount += 1
            if (batchCount === 2) {
              await target
                .prepare("UPDATE conversation_turns SET status = 'replied' WHERE id = ?")
                .bind(first.turnId)
                .run()
            }
            return target.batch(statements)
          }
        }
        // SAFETY: This controlled test fixture matches the asserted contract used by this test.
        const value = target[property as keyof D1Database]
        return value instanceof Function ? value.bind(target) : value
      }
    })
    const racedTurns = makeConversationTurnStore(createCoreDatabase(racedBinding), protection, {
      ownerId,
      now: () => at,
      randomUuid: uuidSequence(700)
    })

    await expect(racedTurns.offer(secondEventId)).resolves.toMatchObject({
      turnId: "00000000-0000-4000-8000-000000000701",
      revision: 1,
      status: "collecting",
      appended: true
    })
    await expect(turns.currentRevision(first.turnId)).resolves.toBe(1)
  })

  it("claims one ready revision as an immutable ordered message snapshot", async () => {
    const { database, protection, ownerKey } = await seedInbound()
    let at = new Date("2026-08-12T08:00:00.000Z")
    const turns = makeConversationTurnStore(database, protection, {
      ownerId,
      now: () => at,
      randomUuid: uuidSequence()
    })
    const first = await turns.offer(firstEventId)
    const secondEventId = "00000000-0000-4000-8000-000000000406"
    const secondMessageId = "00000000-0000-4000-8000-000000000407"
    await addInbound(database, protection, ownerKey, {
      eventId: secondEventId,
      messageId: secondMessageId,
      text: "List",
      at: "2026-08-12T08:00:01.000Z"
    })
    at = new Date("2026-08-12T08:00:01.000Z")
    await turns.offer(secondEventId, "00-11111111111111111111111111111111-2222222222222222-01")
    await expect(turns.claimReady(first.turnId, 90_000)).resolves.toBeUndefined()
    at = new Date("2026-08-12T08:00:02.500Z")

    const snapshot = await turns.claimReady(first.turnId, 90_000)

    expect(snapshot).toMatchObject({
      turnId: first.turnId,
      ownerId,
      channelId,
      revision: 2,
      latest: {
        eventId: secondEventId,
        messageId: secondMessageId,
        text: "List",
        providerMessageHandle: `provider-${secondEventId}`,
        number: "+46700000000",
        fromNumber: "+46711111111",
        traceparent: "00-11111111111111111111111111111111-2222222222222222-01"
      },
      messages: [
        { eventId: firstEventId, messageId: firstMessageId, text: "Lost my reminders", ordinal: 1 },
        { eventId: secondEventId, messageId: secondMessageId, text: "List", ordinal: 2 }
      ]
    })
    await expect(turns.claimReady(first.turnId, 90_000)).resolves.toBeUndefined()
  })

  it("orders a snapshot by provider time when queue offers arrive out of order", async () => {
    const { database, protection, ownerKey } = await seedInbound()
    let at = new Date("2026-08-12T08:00:00.000Z")
    const turns = makeConversationTurnStore(database, protection, {
      ownerId,
      now: () => at,
      randomUuid: uuidSequence()
    })
    const first = await turns.offer(firstEventId)
    const delayedEventId = "00000000-0000-4000-8000-000000000440"
    const delayedMessageId = "00000000-0000-4000-8000-000000000441"
    await addInbound(database, protection, ownerKey, {
      eventId: delayedEventId,
      messageId: delayedMessageId,
      text: "This provider message happened first",
      at: "2026-08-12T07:59:59.000Z"
    })
    at = new Date("2026-08-12T08:00:01.000Z")
    await turns.offer(delayedEventId)
    at = new Date("2026-08-12T08:00:02.500Z")

    await expect(turns.claimReady(first.turnId, 90_000)).resolves.toMatchObject({
      revision: 2,
      latest: {
        eventId: firstEventId,
        messageId: firstMessageId,
        text: "Lost my reminders",
        ordinal: 2
      },
      messages: [
        {
          eventId: delayedEventId,
          messageId: delayedMessageId,
          text: "This provider message happened first",
          ordinal: 1
        },
        {
          eventId: firstEventId,
          messageId: firstMessageId,
          text: "Lost my reminders",
          ordinal: 2
        }
      ]
    })
  })

  it("keeps a duplicate offer in its original turn without increasing the revision", async () => {
    const { database, protection } = await seedInbound()
    const turns = makeConversationTurnStore(database, protection, {
      ownerId,
      now: () => new Date("2026-08-12T08:00:00.000Z"),
      randomUuid: uuidSequence()
    })
    const first = await turns.offer(firstEventId)

    await expect(turns.offer(firstEventId)).resolves.toEqual({
      ...first,
      appended: false
    })
  })

  it("moves a running turn to a new revision while keeping its saved run immutable", async () => {
    const { database, protection, ownerKey } = await seedInbound()
    let at = new Date("2026-08-12T08:00:00.000Z")
    const turns = makeConversationTurnStore(database, protection, {
      ownerId,
      now: () => at,
      randomUuid: uuidSequence()
    })
    const first = await turns.offer(firstEventId)
    at = new Date("2026-08-12T08:00:01.500Z")
    const snapshot = await turns.claimReady(first.turnId, 90_000)
    const firstRunId = "00000000-0000-4000-8000-000000000408"
    await expect(turns.markRunning(first.turnId, snapshot!.revision, firstRunId)).resolves.toBe(
      true
    )
    await expect(
      turns.markRunning(first.turnId, snapshot!.revision, "00000000-0000-4000-8000-000000000499")
    ).resolves.toBe(false)
    const secondEventId = "00000000-0000-4000-8000-000000000409"
    const secondMessageId = "00000000-0000-4000-8000-000000000410"
    await addInbound(database, protection, ownerKey, {
      eventId: secondEventId,
      messageId: secondMessageId,
      text: "Actually include completed reminders",
      at: "2026-08-12T08:00:02.000Z"
    })
    at = new Date("2026-08-12T08:00:02.000Z")
    const offered = await turns.offer(secondEventId)

    expect(offered).toMatchObject({
      revision: 2,
      status: "settling",
      activeRunId: firstRunId
    })
    await expect(turns.currentRevision(first.turnId)).resolves.toBe(2)
    await expect(turns.markRunning(first.turnId, 1, firstRunId)).resolves.toBe(false)
    await expect(turns.releaseSettling(first.turnId, firstRunId)).resolves.toMatchObject({
      ready: true
    })
    at = new Date("2026-08-12T08:00:03.500Z")
    await expect(turns.claimReady(first.turnId, 90_000)).resolves.toMatchObject({ revision: 2 })
    await expect(
      turns.markRunning(first.turnId, 2, "00000000-0000-4000-8000-000000000411")
    ).resolves.toBe(true)
  })

  it("commits only the current run revision and processes all messages once", async () => {
    const { database, protection } = await seedInbound()
    let at = new Date("2026-08-12T08:00:00.000Z")
    const turns = makeConversationTurnStore(database, protection, {
      ownerId,
      now: () => at,
      randomUuid: uuidSequence()
    })
    const offered = await turns.offer(firstEventId)
    at = new Date("2026-08-12T08:00:01.500Z")
    const snapshot = await turns.claimReady(offered.turnId, 90_000)
    const runId = "00000000-0000-4000-8000-000000000412"
    await turns.markRunning(offered.turnId, snapshot!.revision, runId)

    await expect(
      turns.commitReply(
        offered.turnId,
        snapshot!.revision - 1,
        runId,
        "00000000-0000-4000-8000-000000000413"
      )
    ).resolves.toBe("superseded")
    await expect(
      turns.commitReply(
        offered.turnId,
        snapshot!.revision,
        runId,
        "00000000-0000-4000-8000-000000000413"
      )
    ).resolves.toBe("committed")
    await expect(
      turns.commitReply(
        offered.turnId,
        snapshot!.revision,
        runId,
        "00000000-0000-4000-8000-000000000413"
      )
    ).resolves.toBe("committed")
    await expect(turns.markEventsProcessed(offered.turnId, snapshot!.revision)).resolves.toBe(1)
  })

  it("never reclaims a revision while its reply waits for delivery", async () => {
    const { database, protection } = await seedInbound()
    let at = new Date("2026-08-12T08:00:00.000Z")
    const turns = makeConversationTurnStore(database, protection, {
      ownerId,
      now: () => at,
      randomUuid: uuidSequence()
    })
    const offered = await turns.offer(firstEventId)
    at = new Date("2026-08-12T08:00:01.500Z")
    const snapshot = await turns.claimReady(offered.turnId, 90_000)
    const runId = "00000000-0000-4000-8000-000000000429"
    await turns.markRunning(offered.turnId, snapshot!.revision, runId)
    await turns.commitReply(
      offered.turnId,
      snapshot!.revision,
      runId,
      "00000000-0000-4000-8000-000000000430"
    )

    await expect(turns.claimReady(offered.turnId, 90_000)).resolves.toBeUndefined()
  })

  it("reclaims an expired running revision with its immutable run identity", async () => {
    const { database, protection } = await seedInbound()
    let at = new Date("2026-08-12T08:00:00.000Z")
    const turns = makeConversationTurnStore(database, protection, {
      ownerId,
      claimLeaseMs: 1_000,
      now: () => at,
      randomUuid: uuidSequence()
    })
    const offered = await turns.offer(firstEventId)
    at = new Date("2026-08-12T08:00:01.500Z")
    const firstClaim = await turns.claimReady(offered.turnId, 1_000)
    const runId = "00000000-0000-4000-8000-000000000431"
    await turns.markRunning(offered.turnId, firstClaim!.revision, runId)
    at = new Date("2026-08-12T08:00:02.500Z")

    await expect(turns.claimReady(offered.turnId, 90_000)).resolves.toMatchObject({
      turnId: offered.turnId,
      revision: 1,
      latest: { eventId: firstEventId },
      messages: [{ eventId: firstEventId, ordinal: 1 }]
    })
    await expect(turns.markRunning(offered.turnId, 1, runId)).resolves.toBe(true)
  })

  it("collects a newer inbound without steering a run that already committed", async () => {
    const { database, protection, ownerKey } = await seedInbound()
    let at = new Date("2026-08-12T08:00:00.000Z")
    const turns = makeConversationTurnStore(database, protection, {
      ownerId,
      now: () => at,
      randomUuid: uuidSequence()
    })
    const first = await turns.offer(firstEventId)
    at = new Date("2026-08-12T08:00:01.500Z")
    const snapshot = await turns.claimReady(first.turnId, 90_000)
    const runId = "00000000-0000-4000-8000-000000000422"
    const replyOutboxId = "00000000-0000-4000-8000-000000000423"
    await turns.markRunning(first.turnId, snapshot!.revision, runId)
    await turns.commitReply(first.turnId, snapshot!.revision, runId, replyOutboxId)
    const secondEventId = "00000000-0000-4000-8000-000000000424"
    const secondMessageId = "00000000-0000-4000-8000-000000000425"
    await addInbound(database, protection, ownerKey, {
      eventId: secondEventId,
      messageId: secondMessageId,
      text: "Actually, list all reminders",
      at: "2026-08-12T08:00:02.000Z"
    })
    at = new Date("2026-08-12T08:00:02.000Z")

    await expect(turns.offer(secondEventId)).resolves.toMatchObject({
      turnId: first.turnId,
      revision: 2,
      status: "collecting",
      appended: true
    })
    await expect(turns.offer(secondEventId)).resolves.not.toHaveProperty("activeRunId")
    await expect(database.select().from(conversationTurns)).resolves.toEqual([
      expect.objectContaining({
        revision: 2,
        status: "collecting",
        replyOutboxId: null
      })
    ])
  })

  it("starts mutation reflection after a newer inbound supersedes a committed reply", async () => {
    const { database, protection, ownerKey } = await seedInbound()
    let at = new Date("2026-08-12T08:00:00.000Z")
    const turns = makeConversationTurnStore(database, protection, {
      ownerId,
      now: () => at,
      randomUuid: uuidSequence()
    })
    const first = await turns.offer(firstEventId)
    at = new Date("2026-08-12T08:00:01.500Z")
    const firstClaim = await turns.claimReady(first.turnId, 90_000)
    const firstRunId = "00000000-0000-4000-8000-000000000426"
    await turns.markRunning(first.turnId, firstClaim!.revision, firstRunId)
    await turns.commitReply(
      first.turnId,
      firstClaim!.revision,
      firstRunId,
      "00000000-0000-4000-8000-000000000427"
    )

    const secondEventId = "00000000-0000-4000-8000-000000000428"
    const secondMessageId = "00000000-0000-4000-8000-000000000429"
    await addInbound(database, protection, ownerKey, {
      eventId: secondEventId,
      messageId: secondMessageId,
      text: "Actually at eight",
      at: "2026-08-12T08:00:02.000Z"
    })
    at = new Date("2026-08-12T08:00:02.000Z")
    await turns.offer(secondEventId)
    at = new Date("2026-08-12T08:00:03.500Z")
    const reflectionClaim = await turns.claimReady(first.turnId, 90_000)
    expect(reflectionClaim).toMatchObject({
      revision: 2,
      latest: { eventId: secondEventId, messageId: secondMessageId }
    })

    const reflectionRunId = "00000000-0000-4000-8000-000000000430"
    const reflectionAttemptId = "00000000-0000-4000-8000-000000000431"
    await turns.markRunning(first.turnId, reflectionClaim!.revision, reflectionRunId)
    await insertExecutingConversationRun(database, {
      turnId: first.turnId,
      runId: reflectionRunId,
      attemptId: reflectionAttemptId,
      revision: reflectionClaim!.revision,
      at: at.toISOString()
    })
    const runs = makeAgentRunStore(database, protection, { now: () => at })

    await expect(
      runs.completeForReflection(
        {
          protocolVersion: 1,
          runId: reflectionRunId,
          correlationId: "00000000-0000-4000-8000-000000000405",
          status: "failed",
          errorCode: "provider",
          model: "gpt-test",
          durationMs: 100,
          inputTokens: 10,
          outputTokens: 2,
          toolCalls: 1
        },
        reflectionAttemptId,
        { conversationTurnId: first.turnId, conversationTurnRevision: 2 }
      )
    ).resolves.toEqual({
      status: "released",
      revision: 3,
      wakeAt: "2026-08-12T08:00:03.500Z"
    })
    await expect(database.select().from(conversationTurns)).resolves.toEqual([
      expect.objectContaining({
        revision: 3,
        status: "collecting",
        replyOutboxId: null,
        activeRunId: null
      })
    ])
  })

  it("claims the earliest ready turn for its configured owner", async () => {
    const { database, protection } = await seedInbound()
    let at = new Date("2026-08-12T08:00:00.000Z")
    const turns = makeConversationTurnStore(database, protection, {
      ownerId,
      now: () => at,
      randomUuid: uuidSequence()
    })
    const offered = await turns.offer(firstEventId)
    at = new Date("2026-08-12T08:00:01.500Z")

    await expect(turns.claimReady()).resolves.toMatchObject({
      turnId: offered.turnId,
      ownerId,
      revision: 1,
      claimExpiresAt: "2026-08-12T08:02:21.500Z"
    })
  })

  it("renews the conversation lease when an active run starts", async () => {
    const { database, protection } = await seedInbound()
    let at = new Date("2026-08-12T08:00:00.000Z")
    const turns = makeConversationTurnStore(database, protection, {
      ownerId,
      now: () => at,
      randomUuid: uuidSequence()
    })
    const offered = await turns.offer(firstEventId)
    at = new Date("2026-08-12T08:00:01.500Z")
    const snapshot = await turns.claimReady(offered.turnId, 1_000)
    at = new Date("2026-08-12T08:00:02.000Z")

    await expect(
      turns.markRunning(offered.turnId, snapshot!.revision, "00000000-0000-4000-8000-000000000442")
    ).resolves.toBe(true)
    await expect(turns.nextWakeAt()).resolves.toBe("2026-08-12T08:02:22.000Z")
  })

  it("waits for an active tool before it releases the newest revision", async () => {
    const { database, protection, ownerKey } = await seedInbound()
    let at = new Date("2026-08-12T08:00:00.000Z")
    const turns = makeConversationTurnStore(database, protection, {
      ownerId,
      now: () => at,
      randomUuid: uuidSequence()
    })
    const first = await turns.offer(firstEventId)
    at = new Date("2026-08-12T08:00:01.500Z")
    const snapshot = await turns.claimReady(first.turnId, 90_000)
    const activeRunId = "00000000-0000-4000-8000-000000000414"
    await turns.markRunning(first.turnId, snapshot!.revision, activeRunId)
    const secondEventId = "00000000-0000-4000-8000-000000000415"
    const secondMessageId = "00000000-0000-4000-8000-000000000416"
    await addInbound(database, protection, ownerKey, {
      eventId: secondEventId,
      messageId: secondMessageId,
      text: "Actually make it 8",
      at: "2026-08-12T08:00:02.000Z"
    })
    at = new Date("2026-08-12T08:00:02.000Z")
    const newer = await turns.offer(secondEventId)

    await expect(turns.markSettling(first.turnId, newer.revision, activeRunId)).resolves.toEqual({
      claimExpiresAt: "2026-08-12T08:02:21.500Z"
    })
    at = new Date("2026-08-12T08:00:03.500Z")
    await expect(turns.claimReady(first.turnId, 90_000)).resolves.toBeUndefined()
    await expect(turns.releaseSettling(first.turnId, activeRunId)).resolves.toEqual({
      ready: true,
      quietUntil: "2026-08-12T08:00:03.500Z"
    })
    await expect(turns.claimReady(first.turnId, 90_000)).resolves.toMatchObject({
      revision: 2,
      latest: { eventId: secondEventId, text: "Actually make it 8" }
    })
  })

  it("extends a settling lease for a mutation that started near the model deadline", async () => {
    const { database, protection, ownerKey } = await seedInbound()
    let at = new Date("2026-08-12T08:00:00.000Z")
    const turns = makeConversationTurnStore(database, protection, {
      ownerId,
      now: () => at,
      randomUuid: uuidSequence()
    })
    const first = await turns.offer(firstEventId)
    at = new Date("2026-08-12T08:00:01.500Z")
    const snapshot = await turns.claimReady(first.turnId)
    const activeRunId = "00000000-0000-4000-8000-000000000443"
    await turns.markRunning(first.turnId, snapshot!.revision, activeRunId)
    const secondEventId = "00000000-0000-4000-8000-000000000444"
    const secondMessageId = "00000000-0000-4000-8000-000000000445"
    await addInbound(database, protection, ownerKey, {
      eventId: secondEventId,
      messageId: secondMessageId,
      text: "Use the latest correction",
      at: "2026-08-12T08:02:00.000Z"
    })
    at = new Date("2026-08-12T08:02:00.000Z")
    const newer = await turns.offer(secondEventId)

    await expect(turns.markSettling(first.turnId, newer.revision, activeRunId)).resolves.toEqual({
      claimExpiresAt: "2026-08-12T08:03:10.000Z"
    })
  })

  it("keeps one trailing debounce window across abort and a third message", async () => {
    const { database, protection, ownerKey } = await seedInbound()
    let at = new Date("2026-08-12T08:00:00.000Z")
    const turns = makeConversationTurnStore(database, protection, {
      ownerId,
      now: () => at,
      randomUuid: uuidSequence()
    })
    const first = await turns.offer(firstEventId)
    at = new Date("2026-08-12T08:00:01.500Z")
    const snapshot = await turns.claimReady(first.turnId, 90_000)
    const activeRunId = "00000000-0000-4000-8000-000000000426"
    await turns.markRunning(first.turnId, snapshot!.revision, activeRunId)
    const secondEventId = "00000000-0000-4000-8000-000000000427"
    const secondMessageId = "00000000-0000-4000-8000-000000000428"
    await addInbound(database, protection, ownerKey, {
      eventId: secondEventId,
      messageId: secondMessageId,
      text: "Use the latest request",
      at: "2026-08-12T08:00:02.000Z"
    })
    at = new Date("2026-08-12T08:00:02.000Z")

    const newer = await turns.offer(secondEventId)

    expect(newer).toMatchObject({
      revision: 2,
      status: "settling",
      activeRunId
    })
    at = new Date("2026-08-12T08:00:02.050Z")
    await expect(turns.releaseSettling(first.turnId, activeRunId)).resolves.toEqual({
      ready: true,
      quietUntil: "2026-08-12T08:00:03.500Z"
    })
    await expect(
      turns.markSettling(first.turnId, newer.revision, activeRunId)
    ).resolves.toBeUndefined()
    await expect(turns.claimReady(first.turnId, 90_000)).resolves.toBeUndefined()

    const thirdEventId = "00000000-0000-4000-8000-000000000432"
    const thirdMessageId = "00000000-0000-4000-8000-000000000433"
    await addInbound(database, protection, ownerKey, {
      eventId: thirdEventId,
      messageId: thirdMessageId,
      text: "This is the final correction",
      at: "2026-08-12T08:00:02.500Z"
    })
    at = new Date("2026-08-12T08:00:02.500Z")
    await expect(turns.offer(thirdEventId)).resolves.toMatchObject({
      revision: 3,
      status: "collecting",
      quietUntil: "2026-08-12T08:00:04.000Z"
    })
    at = new Date("2026-08-12T08:00:03.500Z")
    await expect(turns.claimReady(first.turnId, 90_000)).resolves.toBeUndefined()
    at = new Date("2026-08-12T08:00:04.000Z")
    await expect(turns.claimReady(first.turnId, 90_000)).resolves.toMatchObject({
      revision: 3,
      latest: { eventId: thirdEventId },
      messages: [
        { eventId: firstEventId, ordinal: 1 },
        { eventId: secondEventId, ordinal: 2 },
        { eventId: thirdEventId, ordinal: 3 }
      ]
    })
    await expect(turns.claimReady(first.turnId, 90_000)).resolves.toBeUndefined()
  })

  it("recovers an expired settling lease after a coordinator restart", async () => {
    const { database, protection, ownerKey } = await seedInbound()
    let at = new Date("2026-08-12T08:00:00.000Z")
    const turns = makeConversationTurnStore(database, protection, {
      ownerId,
      claimLeaseMs: 1_000,
      settleLeaseMs: 500,
      now: () => at,
      randomUuid: uuidSequence()
    })
    const first = await turns.offer(firstEventId)
    at = new Date("2026-08-12T08:00:01.500Z")
    const snapshot = await turns.claimReady(first.turnId, 1_000)
    const activeRunId = "00000000-0000-4000-8000-000000000417"
    await turns.markRunning(first.turnId, snapshot!.revision, activeRunId)
    const secondEventId = "00000000-0000-4000-8000-000000000418"
    const secondMessageId = "00000000-0000-4000-8000-000000000419"
    await addInbound(database, protection, ownerKey, {
      eventId: secondEventId,
      messageId: secondMessageId,
      text: "Latest correction",
      at: "2026-08-12T08:00:02.000Z"
    })
    at = new Date("2026-08-12T08:00:02.000Z")
    const newer = await turns.offer(secondEventId)
    await turns.markSettling(first.turnId, newer.revision, activeRunId)
    await expect(turns.nextWakeAt()).resolves.toBe("2026-08-12T08:00:02.500Z")
    at = new Date("2026-08-12T08:00:03.000Z")

    await expect(turns.claimReady(first.turnId, 90_000)).resolves.toBeUndefined()
    await expect(turns.nextWakeAt()).resolves.toBe("2026-08-12T08:00:03.500Z")
    at = new Date("2026-08-12T08:00:03.500Z")

    await expect(turns.claimReady(first.turnId, 90_000)).resolves.toMatchObject({
      revision: 2,
      latest: { eventId: secondEventId, text: "Latest correction" }
    })
  })
})
