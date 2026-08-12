import { applyD1Migrations, reset } from "cloudflare:test"
import { env } from "cloudflare:workers"
import { eq } from "drizzle-orm"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { createCoreDatabase } from "../src/database.ts"
import { channels, conversationTurns, users } from "../src/modules/conversations/schema.ts"
import { outboxMessages } from "../src/modules/delivery/schema.ts"
import { makeDeliveryStore } from "../src/modules/delivery/store.ts"
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

const ownerId = "00000000-0000-4000-8000-000000000001"
const channelId = "00000000-0000-4000-8000-000000000002"
const turnId = "00000000-0000-4000-8000-000000000003"

function key(byte: number): string {
  let binary = ""
  for (const value of new Uint8Array(32).fill(byte)) binary += String.fromCharCode(value)
  return btoa(binary)
}

beforeEach(async () => {
  await applyD1Migrations(env.DB, decodeTestMigrations(env.TEST_MIGRATIONS))
})

afterEach(async () => {
  await reset()
})

async function seedOwnerChannelAndTurn() {
  const database = createCoreDatabase(env.DB)
  const protection = createDataProtection({ 1: key(1) }, 1, key(2))
  const wrapped = await protection.createWrappedDataKey()
  const sender = await protection.encryptText(wrapped.key, "+46700000000")
  const destination = await protection.encryptText(wrapped.key, "+46711111111")
  const senderHash = await protection.hashLookup("+46700000000")
  const destinationHash = await protection.hashLookup("+46711111111")
  const at = "2026-08-12T10:00:00.000Z"

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
    database.insert(conversationTurns).values({
      id: turnId,
      userId: ownerId,
      channelId,
      status: "committing",
      revision: 1,
      latestInboundEventId: "00000000-0000-4000-8000-000000000004",
      latestMessageId: "00000000-0000-4000-8000-000000000005",
      quietUntil: at,
      burstExpiresAt: at,
      createdAt: at,
      updatedAt: at
    })
  ])

  let next = 100
  const delivery = makeDeliveryStore(database, protection, {
    now: () => new Date("2026-08-12T10:00:01.000Z"),
    randomUuid: () => `00000000-0000-4000-8000-${String(next++).padStart(12, "0")}`
  })
  return { database, delivery }
}

describe("delivery conversation turn fence", () => {
  it("cancels a reply when a newer conversation revision exists", async () => {
    const { database, delivery } = await seedOwnerChannelAndTurn()
    const outboxId = await delivery.createOutbox({
      ownerId,
      channelId,
      text: "Obsolete reply",
      reasonCode: "agent_reply",
      correlationId: "00000000-0000-4000-8000-000000000006",
      idempotencyKey: "turn:revision:1:reply",
      conversationTurnId: turnId,
      conversationTurnRevision: 1
    })
    await database.update(conversationTurns).set({
      replyOutboxId: outboxId,
      revision: 2,
      status: "collecting",
      updatedAt: "2026-08-12T10:00:02.000Z"
    })

    await expect(delivery.claimOutbox(outboxId, 60_000)).resolves.toBeUndefined()
    await expect(delivery.outboxDisposition(outboxId)).resolves.toBe("complete")
    const [turn] = await database.select().from(conversationTurns)
    expect(turn).toMatchObject({
      status: "collecting",
      revision: 2,
      repliedAt: null
    })
  })

  it("claims the reply committed for the current conversation revision", async () => {
    const { database, delivery } = await seedOwnerChannelAndTurn()
    const outboxId = await delivery.createOutbox({
      ownerId,
      channelId,
      text: "Current reply",
      reasonCode: "agent_reply",
      correlationId: "00000000-0000-4000-8000-000000000007",
      idempotencyKey: "turn:current:reply",
      conversationTurnId: turnId,
      conversationTurnRevision: 1
    })
    await database
      .update(conversationTurns)
      .set({ replyOutboxId: outboxId, updatedAt: "2026-08-12T10:00:02.000Z" })

    await expect(delivery.claimOutbox(outboxId, 60_000)).resolves.toMatchObject({ outboxId })
    const [turn] = await database.select().from(conversationTurns)
    expect(turn).toMatchObject({
      status: "replied",
      repliedAt: "2026-08-12T10:00:01.000Z",
      updatedAt: "2026-08-12T10:00:01.000Z"
    })
  })

  it("releases an artifact follow-up only after the reply is accepted", async () => {
    const { database, delivery } = await seedOwnerChannelAndTurn()
    const primaryOutboxId = await delivery.createOutbox({
      ownerId,
      channelId,
      text: "No problem. Here is the updated plan.",
      reasonCode: "agent_reply",
      correlationId: "00000000-0000-4000-8000-000000000015",
      idempotencyKey: "turn:artifact:reply",
      conversationTurnId: turnId,
      conversationTurnRevision: 1
    })
    const artifactOutboxId = await delivery.createOutbox({
      ownerId,
      channelId,
      text: "Biceps · Thursday, August 13\n\nWorkout\n1. Hammer curl — 3 × 10–12",
      reasonCode: "agent_artifact",
      correlationId: "00000000-0000-4000-8000-000000000015",
      idempotencyKey: "turn:artifact:follow-up",
      dependsOnOutboxId: primaryOutboxId
    })
    await database
      .update(conversationTurns)
      .set({ replyOutboxId: primaryOutboxId, updatedAt: "2026-08-12T10:00:02.000Z" })

    await expect(delivery.claimOutbox(artifactOutboxId, 60_000)).resolves.toBeUndefined()
    await expect(delivery.outboxDisposition(artifactOutboxId)).resolves.toBe("active")

    const primaryClaim = await delivery.claimOutbox(primaryOutboxId, 60_000)
    expect(primaryClaim).toBeDefined()
    await expect(
      delivery.recordResult({
        outboxId: primaryOutboxId,
        attemptId: primaryClaim!.attemptId,
        correlationId: "00000000-0000-4000-8000-000000000015",
        state: "accepted",
        providerMessageHandle: "provider-primary",
        occurredAt: "2026-08-12T10:00:03.000Z"
      })
    ).resolves.toEqual([artifactOutboxId])
    await expect(delivery.claimOutbox(artifactOutboxId, 60_000)).resolves.toMatchObject({
      outboxId: artifactOutboxId,
      smsSafeText: "Biceps · Thursday, August 13\n\nWorkout\n1. Hammer curl — 3 × 10–12"
    })
  })

  it("closes the turn before post-claim work can fail", async () => {
    const { database, delivery } = await seedOwnerChannelAndTurn()
    const outboxId = await delivery.createOutbox({
      ownerId,
      channelId,
      text: "Current reply",
      reasonCode: "agent_reply",
      correlationId: "00000000-0000-4000-8000-000000000012",
      idempotencyKey: "turn:post-claim-failure:reply",
      conversationTurnId: turnId,
      conversationTurnRevision: 1
    })
    await database
      .update(conversationTurns)
      .set({ replyOutboxId: outboxId, updatedAt: "2026-08-12T10:00:02.000Z" })
    await env.DB.prepare(`
      CREATE TRIGGER fail_delivery_attempt_after_claim
      BEFORE INSERT ON delivery_attempts
      WHEN NEW.outbox_id = '${outboxId}'
      BEGIN
        SELECT RAISE(FAIL, 'injected post-claim failure');
      END
    `).run()

    await expect(delivery.claimOutbox(outboxId, 60_000)).rejects.toThrow()
    const [turn] = await database.select().from(conversationTurns)
    expect(turn).toMatchObject({
      status: "replied",
      repliedAt: "2026-08-12T10:00:01.000Z"
    })
  })

  it("closes the turn when an exact claimed reply is cancelled for opt-out", async () => {
    const { database, delivery } = await seedOwnerChannelAndTurn()
    const outboxId = await delivery.createOutbox({
      ownerId,
      channelId,
      text: "Current reply",
      reasonCode: "agent_reply",
      correlationId: "00000000-0000-4000-8000-000000000013",
      idempotencyKey: "turn:opted-out:reply",
      conversationTurnId: turnId,
      conversationTurnRevision: 1
    })
    await database.batch([
      database
        .update(conversationTurns)
        .set({ replyOutboxId: outboxId, updatedAt: "2026-08-12T10:00:02.000Z" }),
      database
        .update(channels)
        .set({ optedOutAt: "2026-08-12T10:00:00.500Z" })
        .where(eq(channels.id, channelId))
    ])

    await expect(delivery.claimOutbox(outboxId, 60_000)).resolves.toBeUndefined()
    await expect(delivery.outboxDisposition(outboxId)).resolves.toBe("complete")
    const [turn] = await database.select().from(conversationTurns)
    expect(turn).toMatchObject({
      status: "replied",
      repliedAt: "2026-08-12T10:00:01.000Z"
    })
  })

  it("keeps a newer revision open when it arrives after the delivery claim", async () => {
    const { database, delivery } = await seedOwnerChannelAndTurn()
    const outboxId = await delivery.createOutbox({
      ownerId,
      channelId,
      text: "Accepted before steering",
      reasonCode: "agent_reply",
      correlationId: "00000000-0000-4000-8000-000000000011",
      idempotencyKey: "turn:claim-race:reply",
      conversationTurnId: turnId,
      conversationTurnRevision: 1
    })
    await database
      .update(conversationTurns)
      .set({ replyOutboxId: outboxId, updatedAt: "2026-08-12T10:00:02.000Z" })
    await env.DB.prepare(`
      CREATE TRIGGER simulate_newer_turn_revision
      AFTER UPDATE OF state ON outbox_messages
      WHEN NEW.id = '${outboxId}' AND NEW.state = 'claimed'
      BEGIN
        UPDATE conversation_turns
        SET status = 'collecting', revision = 2, reply_outbox_id = NULL
        WHERE id = '${turnId}';
      END
    `).run()

    await expect(delivery.claimOutbox(outboxId, 60_000)).resolves.toMatchObject({ outboxId })
    const [turn] = await database.select().from(conversationTurns)
    expect(turn).toMatchObject({
      status: "collecting",
      revision: 2,
      replyOutboxId: null,
      repliedAt: null
    })
  })

  it("defers a current reply until its conversation turn commits", async () => {
    const { database, delivery } = await seedOwnerChannelAndTurn()
    const outboxId = await delivery.createOutbox({
      ownerId,
      channelId,
      text: "Uncommitted reply",
      reasonCode: "agent_reply",
      correlationId: "00000000-0000-4000-8000-000000000008",
      idempotencyKey: "turn:uncommitted:reply",
      conversationTurnId: turnId,
      conversationTurnRevision: 1
    })

    await expect(delivery.claimOutbox(outboxId, 60_000)).resolves.toBeUndefined()
    await expect(delivery.outboxDisposition(outboxId)).resolves.toBe("active")

    await database
      .update(conversationTurns)
      .set({ replyOutboxId: outboxId, updatedAt: "2026-08-12T10:00:02.000Z" })

    await expect(delivery.claimOutbox(outboxId, 60_000)).resolves.toMatchObject({ outboxId })
  })

  it("excludes an uncommitted current reply from scheduled recovery", async () => {
    const { database, delivery } = await seedOwnerChannelAndTurn()
    const outboxId = await delivery.createOutbox({
      ownerId,
      channelId,
      text: "Uncommitted reply",
      reasonCode: "agent_reply",
      correlationId: "00000000-0000-4000-8000-000000000014",
      idempotencyKey: "turn:uncommitted:scheduled",
      conversationTurnId: turnId,
      conversationTurnRevision: 1
    })

    const { recoverablePendingOutbox } = await import("../src/modules/delivery/store.ts")
    const recoverable = await database
      .select({ id: outboxMessages.id })
      .from(outboxMessages)
      .where(recoverablePendingOutbox)

    expect(recoverable).not.toContainEqual({ id: outboxId })
  })

  it("keeps legacy outbox rows claimable during rollout", async () => {
    const { delivery } = await seedOwnerChannelAndTurn()
    const outboxId = await delivery.createOutbox({
      ownerId,
      channelId,
      text: "Legacy reply",
      reasonCode: "test",
      correlationId: "00000000-0000-4000-8000-000000000009",
      idempotencyKey: "legacy:reply"
    })

    await expect(delivery.claimOutbox(outboxId, 60_000)).resolves.toMatchObject({ outboxId })
  })

  it("rejects incomplete conversation delivery metadata", async () => {
    const { delivery } = await seedOwnerChannelAndTurn()

    await expect(
      delivery.createOutbox({
        ownerId,
        channelId,
        text: "Invalid reply",
        reasonCode: "agent_reply",
        correlationId: "00000000-0000-4000-8000-000000000010",
        idempotencyKey: "turn:incomplete:reply",
        conversationTurnId: turnId
      })
    ).rejects.toThrow("Conversation turn delivery metadata is incomplete")
  })
})
