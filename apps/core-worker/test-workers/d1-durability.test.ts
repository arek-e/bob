import { makeCaptureTelemetry } from "@bob/observability/testing"
import {
  applyD1Migrations,
  createExecutionContext,
  createMessageBatch,
  getQueueResult,
  reset,
  runInDurableObject
} from "cloudflare:test"
import { env } from "cloudflare:workers"
import { eq } from "drizzle-orm"
import { Effect } from "effect"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import type { CoreBindings } from "../src/bindings.ts"

import { composeCore } from "../src/composition.ts"
import { createCoreDatabase } from "../src/database.ts"
import { handleHttp } from "../src/entrypoints/http.ts"
import { handleInboundQueue } from "../src/entrypoints/queue.ts"
import { operationalAlerts } from "../src/modules/alerts/schema.ts"
import { makeContextStore } from "../src/modules/context/store.ts"
import { makeAgentRunStore } from "../src/modules/conversations/run-store.ts"
import {
  agentRuns,
  channels,
  effectAttempts,
  inboundEvents,
  messages,
  shortReplyBindings,
  toolCalls,
  users
} from "../src/modules/conversations/schema.ts"
import { makeConversationStore } from "../src/modules/conversations/store.ts"
import { makeToolExecutor, toolCommandHash } from "../src/modules/conversations/tool-executor.ts"
import { deliveryAttempts, outboxMessages } from "../src/modules/delivery/schema.ts"
import { makeDeliveryStore } from "../src/modules/delivery/store.ts"
import { journalEntries, journalHandoffs } from "../src/modules/journal/schema.ts"
import { makeJournalStore } from "../src/modules/journal/store.ts"
import {
  factEvidence,
  factRevisions,
  facts,
  memoryCandidates,
  searchDocuments
} from "../src/modules/memory/schema.ts"
import { makeMemoryStore } from "../src/modules/memory/store.ts"
import { createDataProtection } from "../src/modules/policy/data-protection.ts"
import { reminderOccurrences, reminders } from "../src/modules/reminders/schema.ts"
import { makeReminderStore } from "../src/modules/reminders/store.ts"
import { makeOwnerSettingsStore } from "../src/modules/settings/store.ts"
import {
  equipmentExercises,
  exercises,
  gyms,
  routineSteps,
  routines,
  trainingProposals,
  workoutSessions,
  workoutSets
} from "../src/modules/training/schema.ts"
import { makeTrainingStore } from "../src/modules/training/store.ts"
import { processInbound } from "../src/process-inbound.ts"
import { decodeTestMigrations } from "./migrations.ts"

declare global {
  namespace Cloudflare {
    interface Env {
      DB: D1Database
      REMINDER_CLOCK: DurableObjectNamespace
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

async function seedRunData() {
  const database = createCoreDatabase(env.DB)
  const protection = createDataProtection({ 1: key(1) }, 1, key(2))
  const wrapped = await protection.createWrappedDataKey()
  const sender = await protection.encryptText(wrapped.key, "+46700000000")
  const destination = await protection.encryptText(wrapped.key, "+46711111111")
  const inboundText = await protection.encryptText(wrapped.key, "Hello")
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
  return { database, protection, ownerKey: wrapped.key }
}

beforeEach(async () => {
  await applyD1Migrations(env.DB, decodeTestMigrations(env.TEST_MIGRATIONS))
})

afterEach(async () => {
  await reset()
})

describe("D1 migrations and durability", () => {
  it("applies every nested migration in order", async () => {
    const rows = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type IN ('table', 'trigger')"
    ).all<{ name: string }>()
    const names = new Set(rows.results.map((row) => row.name))
    expect(names.has("agent_runs")).toBe(true)
    expect(names.has("search_documents_fts")).toBe(true)
    expect(names.has("journal_entries_valid_handoff")).toBe(true)
    expect(names.has("external_connections")).toBe(true)
  })

  it("rolls back a D1 batch after an injected failure", async () => {
    const statement = env.DB.prepare(
      "INSERT INTO users (id, time_zone, created_at, updated_at) VALUES (?, ?, ?, ?)"
    ).bind(ownerId, "Europe/Stockholm", "2026-08-11T10:00:00.000Z", "2026-08-11T10:00:00.000Z")
    await expect(env.DB.batch([statement, statement])).rejects.toThrow()
    const row = await env.DB.prepare("SELECT COUNT(*) AS count FROM users").first<{
      count: number
    }>()
    expect(row?.count).toBe(0)
  })

  it("claims one reaction and carries the native reply target into delivery", async () => {
    const { database, protection } = await seedRunData()
    await database
      .update(inboundEvents)
      .set({ service: "imessage", isGroup: false })
      .where(eq(inboundEvents.id, inboundId))
    const conversations = makeConversationStore(database, protection, {
      ownerId,
      ownerTimeZone: "Europe/Stockholm",
      dataKeyVersion: 1,
      now: () => new Date("2026-08-11T10:01:00.000Z")
    })

    const claimed = await conversations.claimInbound(inboundId, 90_000)
    expect(claimed).toMatchObject({
      providerMessageHandle: "provider-handle",
      service: "imessage",
      isGroup: false,
      number: "+46700000000",
      fromNumber: "+46711111111"
    })
    await expect(conversations.claimReaction(inboundId, "2026-08-11T10:01:00.000Z")).resolves.toBe(
      true
    )
    await expect(conversations.claimReaction(inboundId, "2026-08-11T10:01:01.000Z")).resolves.toBe(
      false
    )

    const delivery = makeDeliveryStore(database, protection, {
      now: () => new Date("2026-08-11T10:01:02.000Z")
    })
    const outboxId = await delivery.createOutbox({
      ownerId,
      channelId,
      text: "Done",
      reasonCode: "test",
      correlationId,
      idempotencyKey: "native-reply",
      replyToMessageHandle: claimed!.providerMessageHandle
    })
    await expect(delivery.claimOutbox(outboxId, 90_000)).resolves.toMatchObject({
      replyToMessageHandle: "provider-handle"
    })
  })

  it("accepts the first encrypted inbound with production hex keys", async () => {
    const telemetry = makeCaptureTelemetry({
      serviceName: "bob-core-worker",
      serviceVersion: "0123456789abcdef0123456789abcdef01234567",
      deploymentEnvironment: "test"
    })
    const bindings = {
      ...(env as unknown as CoreBindings),
      DATA_KEK_KEYRING_JSON: JSON.stringify({ 1: "07".repeat(32) }),
      DATA_LOOKUP_KEY: "09".repeat(32)
    } satisfies CoreBindings
    const event = {
      id: "00000000-0000-4000-8000-000000000101",
      accountId: "account",
      lineId: "line",
      messageHandle: "first-production-inbound",
      senderE164: "+46700000000",
      destinationE164: "+46711111111",
      text: "HELP",
      service: "imessage" as const,
      isGroup: false,
      providerOptedOut: false,
      receivedAt: "2026-08-11T10:00:00.000Z",
      correlationId: "00000000-0000-4000-8000-000000000102"
    }

    const response = await handleHttp(
      new Request("https://core.internal/internal/inbound", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          traceparent: "00-11111111111111111111111111111111-2222222222222222-01",
          "x-bob-caller-token": bindings.INGRESS_CALLER_SECRET
        },
        body: JSON.stringify(event)
      }),
      bindings,
      undefined,
      {
        runPromise: (effect) => Effect.runPromise(effect.pipe(Effect.provide(telemetry.layer)))
      }
    )

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      eventId: event.id,
      duplicate: false,
      shouldEnqueue: true
    })
    const counts = await env.DB.prepare(
      `SELECT
        (SELECT COUNT(*) FROM users) AS users,
        (SELECT COUNT(*) FROM channels) AS channels,
        (SELECT COUNT(*) FROM messages) AS messages,
        (SELECT COUNT(*) FROM inbound_events) AS inbound_events`
    ).first<Record<string, number>>()
    expect(counts).toEqual({ users: 1, channels: 1, messages: 1, inbound_events: 1 })
    const spans = telemetry.finishedSpans()
    const persist = spans.find((span) => span.name === "bob.inbound.persist")
    const accept = spans.find((span) => span.name === "bob.inbound.accept")
    expect(accept).toMatchObject({
      traceId: "11111111111111111111111111111111",
      parentSpanId: "2222222222222222",
      attributes: expect.objectContaining({
        "bob.correlation.id": event.correlationId
      })
    })
    expect(persist).toMatchObject({
      traceId: "11111111111111111111111111111111",
      parentSpanId: accept?.spanId
    })
    expect(
      JSON.stringify(telemetry.finishedSpans(), (_key, value) =>
        typeof value === "bigint" ? value.toString() : value
      )
    ).not.toContain(event.text)
  })

  it("continues the inbound confirmation through one server span", async () => {
    const { database } = await seedRunData()
    const telemetry = makeCaptureTelemetry({
      serviceName: "bob-core-worker",
      serviceVersion: "0123456789abcdef0123456789abcdef01234567",
      deploymentEnvironment: "test"
    })
    const bindings = env as unknown as CoreBindings
    const traceId = "11111111111111111111111111111111"
    const parentSpanId = "2222222222222222"

    const response = await handleHttp(
      new Request(`https://core.internal/internal/inbound/${inboundId}/enqueued`, {
        method: "POST",
        headers: {
          traceparent: `00-${traceId}-${parentSpanId}-01`,
          "x-bob-caller-token": bindings.INGRESS_CALLER_SECRET,
          "x-bob-correlation-id": correlationId
        }
      }),
      bindings,
      undefined,
      {
        runPromise: (effect) => Effect.runPromise(effect.pipe(Effect.provide(telemetry.layer)))
      }
    )

    expect(response.status).toBe(200)
    const confirm = telemetry
      .finishedSpans()
      .find((span) => span.name === "bob.inbound.confirm_accept")
    expect(confirm).toMatchObject({
      traceId,
      parentSpanId,
      kind: "server",
      attributes: expect.objectContaining({ "bob.correlation.id": correlationId })
    })
    const [stored] = await database
      .select({ enqueuedAt: inboundEvents.enqueuedAt })
      .from(inboundEvents)
      .where(eq(inboundEvents.id, inboundId))
      .limit(1)
    expect(stored?.enqueuedAt).toBeDefined()
  })

  it("stores owner locality and reports the Sendblue connection", async () => {
    const { database, protection } = await seedRunData()
    let next = 220
    const settings = makeOwnerSettingsStore(database, protection, {
      defaultTimeZone: "Europe/Stockholm",
      now: () => new Date("2026-08-11T10:05:00.000Z"),
      randomUuid: () => `00000000-0000-4000-8000-${String(next++).padStart(12, "0")}`
    })

    expect(await settings.get(ownerId)).toMatchObject({
      timeZone: "Europe/Stockholm",
      locale: "en",
      hourCycle: "auto"
    })
    expect(await settings.connections(ownerId)).toEqual([
      { provider: "sendblue", status: "connected" }
    ])
    await database
      .update(channels)
      .set({ optedOutAt: "2026-08-11T10:04:00.000Z" })
      .where(eq(channels.id, channelId))
    expect(await settings.connections(ownerId)).toEqual([
      { provider: "sendblue", status: "paused" }
    ])

    const saved = await settings.update(
      ownerId,
      { timeZone: "America/New_York", locale: "en-gb", hourCycle: "h23" },
      "settings:test:update"
    )
    expect(saved).toMatchObject({
      timeZone: "America/New_York",
      locale: "en-GB",
      hourCycle: "h23"
    })
    await expect(
      settings.update(ownerId, { timeZone: "UTC" }, "settings:test:update")
    ).resolves.toMatchObject(saved)
  })

  it("updates owner locality through the bounded messaging tool", async () => {
    const { database, protection } = await seedRunData()
    const runStore = makeAgentRunStore(database, protection, {})
    await runStore.create(
      {
        protocolVersion: 1,
        runId,
        ownerId,
        correlationId,
        sourceMessageId: messageId,
        localTime: "2026-08-11T10:00:00.000Z",
        timeZone: "Europe/Stockholm",
        userText: "Set my time zone to America/New_York and use 24-hour time.",
        contextItems: [],
        allowedTools: ["settings_get", "settings_update"],
        limits: {
          maxTurns: 4,
          maxToolCalls: 4,
          maxDurationMs: 60_000,
          maxResponseCharacters: 1_200
        }
      },
      inboundId
    )
    expect(await runStore.claim(runId, 90_000)).toBeDefined()
    const settings = makeOwnerSettingsStore(database, protection, {
      defaultTimeZone: "Europe/Stockholm"
    })
    const executor = makeToolExecutor(
      database,
      protection,
      {
        reminders: {} as never,
        memory: {} as never,
        journal: {} as never,
        training: {} as never,
        settings
      },
      { uiBaseUrl: "https://bob.example.invalid" }
    )

    const result = await executor.execute({
      runId,
      toolCallId: "settings-call-1",
      idempotencyKey: "settings:tool:update",
      ownerId,
      name: "settings_update",
      arguments: { timeZone: "America/New_York", hourCycle: "h23" }
    })

    expect(result).toMatchObject({
      ok: true,
      code: "owner_settings_updated",
      data: {
        settings: { timeZone: "America/New_York", hourCycle: "h23" }
      }
    })
    await expect(settings.get(ownerId)).resolves.toMatchObject({
      timeZone: "America/New_York",
      hourCycle: "h23"
    })
  })

  it("recovers an exhausted inbound Queue message through the durable event", async () => {
    const { database } = await seedRunData()
    const sent: unknown[] = []
    const queue = {
      send: async (body: unknown) => {
        sent.push(body)
      }
    } as unknown as Queue
    const bindings = {
      ...(env as unknown as CoreBindings),
      INBOUND_QUEUE: queue,
      INBOUND_DEAD_LETTER_QUEUE_NAME: "bob-inbound-dead-letter-test"
    } satisfies CoreBindings
    const batch = createMessageBatch("bob-inbound-dead-letter-test", [
      {
        id: "queue-message-1",
        timestamp: new Date("2026-08-11T10:00:00.000Z"),
        attempts: 6,
        body: { eventId: inboundId }
      }
    ])
    const context = createExecutionContext()

    await handleInboundQueue(batch, bindings)

    const result = await getQueueResult(batch, context)
    const [event] = await database
      .select()
      .from(inboundEvents)
      .where(eq(inboundEvents.id, inboundId))
    expect(result.explicitAcks).toEqual(["queue-message-1"])
    expect(sent).toEqual([
      {
        eventId: inboundId,
        correlationId: inboundId,
        traceparent: expect.stringMatching(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/)
      }
    ])
    expect(event).toMatchObject({ recoveryCount: 1, claimedAt: null, claimExpiresAt: null })
    expect(event?.deadLetteredAt).not.toBeNull()
  })

  it("persists trusted opt-out controls without enqueueing a conversation", async () => {
    const { database, protection } = await seedRunData()
    const conversations = makeConversationStore(database, protection, {
      ownerId,
      ownerTimeZone: "Europe/Stockholm",
      dataKeyVersion: 1,
      now: () => new Date("2026-08-11T10:02:00.000Z"),
      randomUuid: () => "00000000-0000-4000-8000-000000000260"
    })

    const accepted = await conversations.acceptInbound({
      id: "00000000-0000-4000-8000-000000000261",
      accountId: "account",
      lineId: "line",
      messageHandle: "provider-opt-out-control",
      senderE164: "+46700000000",
      destinationE164: "+46711111111",
      text: "CANCEL",
      service: "sms",
      isGroup: false,
      providerOptedOut: true,
      receivedAt: "2026-08-11T10:02:00.000Z",
      correlationId: "00000000-0000-4000-8000-000000000262"
    })

    const [channel] = await database.select().from(channels).where(eq(channels.id, channelId))
    const [event] = await database
      .select()
      .from(inboundEvents)
      .where(eq(inboundEvents.id, accepted.eventId))
    expect(accepted.shouldEnqueue).toBe(false)
    expect(channel?.optedOutAt).toBe("2026-08-11T10:02:00.000Z")
    expect(event?.processedAt).toBe("2026-08-11T10:02:00.000Z")
  })

  it("never sends stored raw messages in model context", async () => {
    const { database, protection } = await seedRunData()
    const context = makeContextStore(database, protection, {})
    expect(await context.build(ownerId, channelId)).toEqual([])
  })

  it("reuses the immutable snapshot after an expired run lease", async () => {
    const { database, protection } = await seedRunData()
    let current = new Date("2026-08-11T10:00:00.000Z")
    let next = 10
    const store = makeAgentRunStore(database, protection, {
      now: () => current,
      randomUuid: () => `00000000-0000-4000-8000-${String(next++).padStart(12, "0")}`
    })
    const request = {
      protocolVersion: 1 as const,
      runId,
      ownerId,
      correlationId,
      sourceMessageId: messageId,
      localTime: current.toISOString(),
      timeZone: "Europe/Stockholm",
      userText: "What is my training routine?",
      contextItems: [],
      allowedTools: ["routine_get" as const],
      limits: { maxTurns: 4, maxToolCalls: 4, maxDurationMs: 60_000, maxResponseCharacters: 1_200 }
    }
    await store.create(request, inboundId)
    const firstAttemptId = await store.claim(runId, 1_000)
    expect(firstAttemptId).toMatch(/^[0-9a-f-]{36}$/)
    current = new Date("2026-08-11T10:00:02.000Z")
    const secondAttemptId = await store.claim(runId, 1_000)
    expect(secondAttemptId).toMatch(/^[0-9a-f-]{36}$/)
    expect(secondAttemptId).not.toBe(firstAttemptId)
    expect((await store.loadForInbound(inboundId))?.request).toEqual(request)
    const [run] = await database.select().from(agentRuns)
    expect(run?.status).toBe("executing")
  })

  it("does not let an expired agent attempt commit after its replacement", async () => {
    const { database, protection } = await seedRunData()
    let current = new Date("2026-08-11T10:00:00.000Z")
    let next = 40
    const store = makeAgentRunStore(database, protection, {
      now: () => current,
      randomUuid: () => `00000000-0000-4000-8000-${String(next++).padStart(12, "0")}`
    })
    const request = {
      protocolVersion: 1 as const,
      runId,
      ownerId,
      correlationId,
      sourceMessageId: messageId,
      localTime: current.toISOString(),
      timeZone: "Europe/Stockholm",
      userText: "Hello",
      contextItems: [],
      allowedTools: [],
      limits: {
        maxTurns: 4,
        maxToolCalls: 4,
        maxDurationMs: 60_000,
        maxResponseCharacters: 1_200
      }
    }
    const result = {
      protocolVersion: 1 as const,
      runId,
      correlationId,
      status: "completed" as const,
      responseText: "Current response",
      model: "test-model",
      durationMs: 1,
      inputTokens: 1,
      outputTokens: 1,
      toolCalls: 0
    }
    await store.create(request, inboundId)
    const expiredAttemptId = await store.claim(runId, 1_000)
    expect(expiredAttemptId).toBeDefined()
    current = new Date("2026-08-11T10:00:02.000Z")
    const currentAttemptId = await store.claim(runId, 1_000)
    expect(currentAttemptId).toBeDefined()

    expect(
      await store.completeWithResponse(
        { ...result, responseText: "Stale response" },
        { channelId, text: "Stale response", reasonCode: "agent_reply" },
        undefined,
        expiredAttemptId!
      )
    ).toBeUndefined()
    expect(await database.select().from(outboxMessages)).toHaveLength(0)

    const outboxId = await store.completeWithResponse(
      result,
      { channelId, text: "Current response", reasonCode: "agent_reply" },
      undefined,
      currentAttemptId!
    )
    expect(outboxId).toBeDefined()
    expect(await database.select().from(outboxMessages)).toHaveLength(1)
    expect(
      await store.completeWithResponse(
        { ...result, responseText: "Late stale response" },
        { channelId, text: "Late stale response", reasonCode: "agent_reply" },
        undefined,
        expiredAttemptId!
      )
    ).toBeUndefined()
    expect(await database.select().from(outboxMessages)).toHaveLength(1)
  })

  it("commits the completed run and response outbox in one batch", async () => {
    const { database, protection } = await seedRunData()
    let next = 100
    const store = makeAgentRunStore(database, protection, {
      now: () => new Date("2026-08-11T10:00:00.000Z"),
      randomUuid: () => `00000000-0000-4000-8000-${String(next++).padStart(12, "0")}`
    })
    await store.create(
      {
        protocolVersion: 1,
        runId,
        ownerId,
        correlationId,
        sourceMessageId: messageId,
        localTime: "2026-08-11T10:00:00.000Z",
        timeZone: "Europe/Stockholm",
        userText: "Hello",
        contextItems: [],
        allowedTools: [],
        limits: {
          maxTurns: 4,
          maxToolCalls: 4,
          maxDurationMs: 60_000,
          maxResponseCharacters: 1_200
        }
      },
      inboundId
    )
    const attemptId = await store.claim(runId, 90_000)
    const outboxId = await store.completeWithResponse(
      {
        protocolVersion: 1,
        runId,
        correlationId,
        status: "completed",
        responseText: "Hello back",
        model: "test-model",
        durationMs: 1,
        inputTokens: 1,
        outputTokens: 1,
        toolCalls: 0
      },
      { channelId, text: "Hello back", reasonCode: "agent_reply" },
      undefined,
      attemptId!
    )
    const [run] = await database.select().from(agentRuns)
    const [outbox] = await database.select().from(outboxMessages)
    expect(run?.status).toBe("completed")
    expect(outbox?.id).toBe(outboxId)
    expect((await store.loadForInbound(inboundId))?.outboxId).toBe(outboxId)
  })

  it("repairs a completed run that has no response outbox", async () => {
    const { database, protection } = await seedRunData()
    const request = {
      protocolVersion: 1 as const,
      runId,
      ownerId,
      correlationId,
      sourceMessageId: messageId,
      localTime: "2026-08-11T10:00:00.000Z",
      timeZone: "Europe/Stockholm",
      userText: "Hello",
      contextItems: [],
      allowedTools: [],
      limits: {
        maxTurns: 4,
        maxToolCalls: 4,
        maxDurationMs: 60_000,
        maxResponseCharacters: 1_200
      }
    }
    const runs = makeAgentRunStore(database, protection, {})
    await runs.create(request, inboundId)
    await database.update(agentRuns).set({ status: "completed" }).where(eq(agentRuns.id, runId))
    const sent: unknown[] = []
    const bindings = {
      ...(env as unknown as CoreBindings),
      OUTBOUND_QUEUE: {
        send: async (body: unknown) => {
          sent.push(body)
        }
      } as unknown as Queue
    } satisfies CoreBindings

    await processInbound(inboundId, bindings, composeCore(bindings))

    const [outbox] = await database.select().from(outboxMessages)
    const [event] = await database
      .select()
      .from(inboundEvents)
      .where(eq(inboundEvents.id, inboundId))
    expect(outbox?.reasonCode).toBe("agent_recovery")
    expect(sent).toEqual([
      {
        outboxId: outbox?.id,
        correlationId,
        traceparent: expect.stringMatching(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/)
      }
    ])
    expect(event?.processedAt).not.toBeNull()
  })

  it("marks a lost Sendblue result uncertain and never resends", async () => {
    const { database, protection } = await seedRunData()
    let current = new Date("2026-08-11T10:00:00.000Z")
    let next = 200
    const delivery = makeDeliveryStore(database, protection, {
      now: () => current,
      randomUuid: () => `00000000-0000-4000-8000-${String(next++).padStart(12, "0")}`
    })
    const outboxId = await delivery.createOutbox({
      ownerId,
      channelId,
      text: "Test reminder",
      reasonCode: "test",
      correlationId,
      idempotencyKey: "test:uncertain"
    })
    expect(await delivery.claimOutbox(outboxId, 1_000)).toBeDefined()
    current = new Date("2026-08-11T10:00:02.000Z")
    expect(await delivery.claimOutbox(outboxId, 1_000)).toBeUndefined()
    const [outbox] = await database
      .select()
      .from(outboxMessages)
      .where(eq(outboxMessages.id, outboxId))
    const [attempt] = await database
      .select()
      .from(deliveryAttempts)
      .where(eq(deliveryAttempts.outboxId, outboxId))
    expect(outbox?.state).toBe("uncertain")
    expect(attempt?.state).toBe("uncertain")
  })

  it("records delivery result queue messages idempotently", async () => {
    const { database, protection } = await seedRunData()
    let next = 225
    const delivery = makeDeliveryStore(database, protection, {
      now: () => new Date("2026-08-11T10:00:00.000Z"),
      randomUuid: () => `00000000-0000-4000-8000-${String(next++).padStart(12, "0")}`
    })
    const outboxId = await delivery.createOutbox({
      ownerId,
      channelId,
      text: "Test result queue",
      reasonCode: "test",
      correlationId,
      idempotencyKey: "test:result-queue"
    })
    const claim = await delivery.claimOutbox(outboxId, 60_000)
    expect(claim).toBeDefined()
    const body = {
      outboxId,
      attemptId: claim!.attemptId,
      state: "accepted",
      providerMessageHandle: "durable-provider-handle",
      occurredAt: "2026-08-11T10:00:01.000Z"
    }
    const bindings = {
      ...(env as unknown as CoreBindings),
      DELIVERY_RESULT_QUEUE_NAME: "bob-delivery-result-test"
    } satisfies CoreBindings

    for (const id of ["result-message-1", "result-message-2"]) {
      const batch = createMessageBatch("bob-delivery-result-test", [
        { id, timestamp: new Date("2026-08-11T10:00:01.000Z"), attempts: 1, body }
      ])
      const context = createExecutionContext()
      await handleInboundQueue(batch, bindings)
      expect((await getQueueResult(batch, context)).explicitAcks).toEqual([id])
    }

    const [attempt] = await database
      .select()
      .from(deliveryAttempts)
      .where(eq(deliveryAttempts.id, claim!.attemptId))
    expect(attempt).toMatchObject({
      state: "accepted",
      providerMessageHandle: "durable-provider-handle"
    })
  })

  it("stores provider opt-out before attempt correlation", async () => {
    const { database, protection } = await seedRunData()
    const delivery = makeDeliveryStore(database, protection, {})

    await delivery.recordProviderEvent({
      id: "00000000-0000-4000-8000-000000000250",
      accountId: "account",
      lineId: "line",
      messageHandle: "unmatched-provider-handle",
      destinationE164: "+46700000000",
      providerOptedOut: true,
      status: "opted_out",
      occurredAt: "2026-08-11T10:01:00.000Z",
      correlationId
    })

    const [channel] = await database.select().from(channels).where(eq(channels.id, channelId))
    expect(channel?.optedOutAt).toBe("2026-08-11T10:01:00.000Z")
  })

  it("replays a callback that arrives before handle binding", async () => {
    const { database, protection } = await seedRunData()
    let next = 300
    const delivery = makeDeliveryStore(database, protection, {
      now: () => new Date("2026-08-11T10:00:00.000Z"),
      randomUuid: () => `00000000-0000-4000-8000-${String(next++).padStart(12, "0")}`
    })
    const outboxId = await delivery.createOutbox({
      ownerId,
      channelId,
      text: "Test",
      reasonCode: "test",
      correlationId,
      idempotencyKey: "test:callback-race"
    })
    const claim = await delivery.claimOutbox(outboxId, 60_000)
    expect(claim).toBeDefined()
    await delivery.recordProviderEvent({
      id: "00000000-0000-4000-8000-000000000301",
      accountId: "account",
      lineId: "line",
      messageHandle: "fast-handle",
      destinationE164: "+46700000000",
      providerOptedOut: false,
      status: "delivered",
      outboxId,
      attemptId: claim!.attemptId,
      occurredAt: "2026-08-11T10:00:01.000Z",
      correlationId
    })
    let [attempt] = await database
      .select()
      .from(deliveryAttempts)
      .where(eq(deliveryAttempts.id, claim!.attemptId))
    expect(attempt?.state).toBe("delivered")

    await delivery.recordProviderEvent({
      id: "00000000-0000-4000-8000-000000000302",
      accountId: "account",
      lineId: "line",
      messageHandle: "fast-handle",
      destinationE164: "+46700000000",
      providerOptedOut: false,
      status: "queued",
      occurredAt: "2026-08-11T10:00:03.000Z",
      correlationId
    })
    ;[attempt] = await database
      .select()
      .from(deliveryAttempts)
      .where(eq(deliveryAttempts.id, claim!.attemptId))
    expect(attempt?.state).toBe("delivered")
  })

  it("moves an accepted reminder to response state and binds exact replies", async () => {
    const { database, protection, ownerKey } = await seedRunData()
    let next = 400
    const at = "2026-08-11T10:00:00.000Z"
    const occurrenceId = "00000000-0000-4000-8000-000000000410"
    const encrypted = await protection.encryptText(ownerKey, "Take medicine")
    await database.batch([
      database.insert(reminders).values({
        id: "00000000-0000-4000-8000-000000000411",
        userId: ownerId,
        sourceMessageId: messageId,
        originalWordingCiphertext: encrypted.ciphertext,
        originalWordingIv: encrypted.iv,
        displayTextCiphertext: encrypted.ciphertext,
        displayTextIv: encrypted.iv,
        smsSafeTextCiphertext: encrypted.ciphertext,
        smsSafeTextIv: encrypted.iv,
        dataKeyVersion: 1,
        sensitivity: "normal",
        scheduleKind: "one_shot",
        localStartDate: "2026-08-11",
        localStartTime: "10:00",
        timeZone: "Europe/Stockholm",
        nextDueAt: null,
        quietHoursBehavior: "defer",
        requiresAcknowledgment: true,
        responseDeadlineMinutes: 60,
        repeatPolicy: "none",
        maxAttempts: 1,
        channelId,
        state: "active",
        scheduleRevision: 1,
        createdAt: at,
        updatedAt: at
      }),
      database.insert(reminderOccurrences).values({
        id: occurrenceId,
        reminderId: "00000000-0000-4000-8000-000000000411",
        sequence: 1,
        intendedDueAt: at,
        localDisplayTime: at,
        idempotencyKey: "reminder:test:one",
        state: "awaiting_delivery",
        responseDeadlineAt: "2026-08-11T11:00:00.000Z",
        createdAt: at,
        updatedAt: at
      })
    ])
    const delivery = makeDeliveryStore(database, protection, {
      now: () => new Date(at),
      randomUuid: () => `00000000-0000-4000-8000-${String(next++).padStart(12, "0")}`
    })
    const outboxId = await delivery.createOutbox({
      ownerId,
      channelId,
      text: "Take medicine",
      reasonCode: "reminder_due",
      correlationId,
      idempotencyKey: "reminder:test:delivery",
      actionTargetType: "reminder_occurrence",
      actionTargetId: occurrenceId
    })
    const claim = await delivery.claimOutbox(outboxId, 60_000)
    await delivery.recordResult({
      outboxId,
      attemptId: claim!.attemptId,
      state: "accepted",
      providerMessageHandle: "reminder-handle",
      occurredAt: "2026-08-11T10:00:01.000Z"
    })
    const [occurrence] = await database
      .select()
      .from(reminderOccurrences)
      .where(eq(reminderOccurrences.id, occurrenceId))
    const bindings = await database
      .select()
      .from(shortReplyBindings)
      .where(eq(shortReplyBindings.targetId, occurrenceId))
    expect(occurrence?.state).toBe("awaiting_response")
    expect(bindings.map((binding) => binding.command).sort()).toEqual(["done", "seen"])
    expect(bindings.every((binding) => binding.expiresAt === "2026-08-11T11:00:00.000Z")).toBe(true)
    const reminderStore = makeReminderStore(database, protection, {
      now: () => new Date("2026-08-11T10:05:00.000Z"),
      randomUuid: () => `00000000-0000-4000-8000-${String(next++).padStart(12, "0")}`
    })
    const seen = bindings.find((binding) => binding.command === "seen")!
    const done = bindings.find((binding) => binding.command === "done")!
    expect(await reminderStore.applyBoundReply(ownerId, seen.id, "seen")).toBe("applied")
    let [updated] = await database
      .select()
      .from(reminderOccurrences)
      .where(eq(reminderOccurrences.id, occurrenceId))
    expect(updated?.state).toBe("acknowledged")
    expect(await reminderStore.applyBoundReply(ownerId, done.id, "done")).toBe("applied")
    ;[updated] = await database
      .select()
      .from(reminderOccurrences)
      .where(eq(reminderOccurrences.id, occurrenceId))
    expect(updated?.state).toBe("completed")
    expect(await reminderStore.list(ownerId)).toEqual([])
  })

  it("marks expired reminder responses missed and consumes reply bindings", async () => {
    const { database, protection, ownerKey } = await seedRunData()
    const at = "2026-08-11T10:00:00.000Z"
    const occurrenceId = "00000000-0000-4000-8000-000000000460"
    const encrypted = await protection.encryptText(ownerKey, "Check the door")
    await database.batch([
      database.insert(reminders).values({
        id: "00000000-0000-4000-8000-000000000461",
        userId: ownerId,
        sourceMessageId: messageId,
        originalWordingCiphertext: encrypted.ciphertext,
        originalWordingIv: encrypted.iv,
        displayTextCiphertext: encrypted.ciphertext,
        displayTextIv: encrypted.iv,
        smsSafeTextCiphertext: encrypted.ciphertext,
        smsSafeTextIv: encrypted.iv,
        dataKeyVersion: 1,
        sensitivity: "normal",
        scheduleKind: "one_shot",
        localStartDate: "2026-08-11",
        localStartTime: "10:00",
        timeZone: "Europe/Stockholm",
        nextDueAt: null,
        quietHoursBehavior: "defer",
        requiresAcknowledgment: true,
        responseDeadlineMinutes: 60,
        repeatPolicy: "none",
        maxAttempts: 1,
        channelId,
        state: "active",
        scheduleRevision: 1,
        createdAt: at,
        updatedAt: at
      }),
      database.insert(reminderOccurrences).values({
        id: occurrenceId,
        reminderId: "00000000-0000-4000-8000-000000000461",
        sequence: 1,
        intendedDueAt: at,
        localDisplayTime: at,
        idempotencyKey: "reminder:test:missed",
        state: "awaiting_response",
        responseDeadlineAt: "2026-08-11T10:30:00.000Z",
        createdAt: at,
        updatedAt: at
      }),
      database.insert(shortReplyBindings).values({
        id: "00000000-0000-4000-8000-000000000462",
        userId: ownerId,
        outboundMessageId: messageId,
        command: "done",
        targetType: "reminder",
        targetId: occurrenceId,
        expiresAt: "2026-08-11T10:30:00.000Z",
        createdAt: at
      })
    ])
    let next = 463
    const reminderStore = makeReminderStore(database, protection, {
      now: () => new Date("2026-08-11T11:00:00.000Z"),
      randomUuid: () => `00000000-0000-4000-8000-${String(next++).padStart(12, "0")}`
    })

    expect(await reminderStore.markExpiredResponseDeadlines("2026-08-11T11:00:00.000Z")).toBe(1)
    const [occurrence] = await database
      .select()
      .from(reminderOccurrences)
      .where(eq(reminderOccurrences.id, occurrenceId))
    const [binding] = await database
      .select()
      .from(shortReplyBindings)
      .where(eq(shortReplyBindings.targetId, occurrenceId))
    const [alert] = await database
      .select()
      .from(operationalAlerts)
      .where(eq(operationalAlerts.objectId, occurrenceId))
    expect(occurrence?.state).toBe("missed")
    expect(binding?.consumedAt).toBe("2026-08-11T11:00:00.000Z")
    expect(alert).toMatchObject({ code: "reminder_missed", objectType: "reminder_occurrence" })
    expect(Object.keys(alert ?? {})).not.toContain("content")
  })

  it("defers reminders during owner quiet hours", async () => {
    const { database, protection } = await seedRunData()
    let next = 480
    const reminderStore = makeReminderStore(database, protection, {
      now: () => new Date("2026-08-11T21:30:00.000Z"),
      randomUuid: () => `00000000-0000-4000-8000-${String(next++).padStart(12, "0")}`,
      quietHours: { start: "22:00", end: "07:00", timeZone: "Europe/Stockholm" },
      dailyLimit: 8
    })
    const created = await reminderStore.createOneShot(
      ownerId,
      channelId,
      "Late reminder",
      {
        displayText: "Late reminder",
        smsSafeText: "Late reminder",
        localDate: "2026-08-11",
        localTime: "23:00",
        timeZone: "Europe/Stockholm",
        dueAt: "2026-08-11T21:00:00.000Z",
        sourceMessageId: messageId,
        requiresAcknowledgment: true
      },
      "reminder:test:quiet-create"
    )

    expect(await reminderStore.claimDueAndCreateOutbox(ownerId, 60_000)).toEqual([])
    const [occurrence] = await database
      .select()
      .from(reminderOccurrences)
      .where(eq(reminderOccurrences.id, created.occurrenceId))
    expect(occurrence).toMatchObject({
      state: "scheduled",
      intendedDueAt: "2026-08-12T05:00:00Z"
    })
  })

  it("uses the saved owner time zone for quiet hours", async () => {
    const { database, protection } = await seedRunData()
    await database.update(users).set({ timeZone: "America/New_York" }).where(eq(users.id, ownerId))
    let next = 485
    const reminderStore = makeReminderStore(database, protection, {
      now: () => new Date("2026-08-11T21:30:00.000Z"),
      randomUuid: () => `00000000-0000-4000-8000-${String(next++).padStart(12, "0")}`,
      quietHours: { start: "22:00", end: "07:00", timeZone: "Europe/Stockholm" },
      dailyLimit: 8
    })
    await reminderStore.createOneShot(
      ownerId,
      channelId,
      "Evening reminder",
      {
        displayText: "Evening reminder",
        smsSafeText: "Evening reminder",
        localDate: "2026-08-11",
        localTime: "17:00",
        timeZone: "America/New_York",
        dueAt: "2026-08-11T21:00:00.000Z",
        sourceMessageId: messageId,
        requiresAcknowledgment: true
      },
      "reminder:test:saved-zone"
    )

    expect(await reminderStore.claimDueAndCreateOutbox(ownerId, 60_000)).toHaveLength(1)
  })

  it("defers reminders after the local daily send limit", async () => {
    const { database, protection } = await seedRunData()
    let next = 490
    const fixedNow = () => new Date("2026-08-11T10:00:00.000Z")
    const delivery = makeDeliveryStore(database, protection, {
      now: fixedNow,
      randomUuid: () => `00000000-0000-4000-8000-${String(next++).padStart(12, "0")}`
    })
    await delivery.createOutbox({
      ownerId,
      channelId,
      text: "Earlier reminder",
      reasonCode: "reminder_due",
      correlationId,
      idempotencyKey: "reminder:test:daily-existing"
    })
    const reminderStore = makeReminderStore(database, protection, {
      now: fixedNow,
      randomUuid: () => `00000000-0000-4000-8000-${String(next++).padStart(12, "0")}`,
      quietHours: { start: "22:00", end: "07:00", timeZone: "Europe/Stockholm" },
      dailyLimit: 1
    })
    const created = await reminderStore.createOneShot(
      ownerId,
      channelId,
      "Limited reminder",
      {
        displayText: "Limited reminder",
        smsSafeText: "Limited reminder",
        localDate: "2026-08-11",
        localTime: "11:30",
        timeZone: "Europe/Stockholm",
        dueAt: "2026-08-11T09:30:00.000Z",
        sourceMessageId: messageId,
        requiresAcknowledgment: true
      },
      "reminder:test:daily-create"
    )

    expect(await reminderStore.claimDueAndCreateOutbox(ownerId, 60_000)).toEqual([])
    const [occurrence] = await database
      .select()
      .from(reminderOccurrences)
      .where(eq(reminderOccurrences.id, created.occurrenceId))
    expect(occurrence?.intendedDueAt).toBe("2026-08-12T05:00:00Z")
  })

  it("persists STOP before delivery and START before resuming", async () => {
    const { database, protection } = await seedRunData()
    let next = 500
    const conversations = makeConversationStore(database, protection, {
      ownerId,
      ownerTimeZone: "Europe/Stockholm",
      dataKeyVersion: 1,
      now: () => new Date("2026-08-11T10:00:00.000Z"),
      randomUuid: () => `00000000-0000-4000-8000-${String(next++).padStart(12, "0")}`
    })
    const base = {
      accountId: "account",
      lineId: "line",
      senderE164: "+46700000000",
      destinationE164: "+46711111111",
      service: "sms" as const,
      isGroup: false,
      providerOptedOut: false,
      receivedAt: "2026-08-11T10:00:00.000Z",
      correlationId
    }
    await conversations.acceptInbound({
      ...base,
      id: "00000000-0000-4000-8000-000000000501",
      messageHandle: "stop-handle",
      text: "STOP"
    })
    let [channel] = await database.select().from(channels).where(eq(channels.id, channelId))
    expect(channel?.optedOutAt).toBe(base.receivedAt)

    const delivery = makeDeliveryStore(database, protection, {
      now: () => new Date("2026-08-11T10:00:01.000Z"),
      randomUuid: () => `00000000-0000-4000-8000-${String(next++).padStart(12, "0")}`
    })
    const blockedId = await delivery.createOutbox({
      ownerId,
      channelId,
      text: "Blocked",
      reasonCode: "test",
      correlationId,
      idempotencyKey: "test:blocked"
    })
    expect(await delivery.claimOutbox(blockedId, 60_000)).toBeUndefined()

    await conversations.acceptInbound({
      ...base,
      id: "00000000-0000-4000-8000-000000000502",
      messageHandle: "start-handle",
      text: "START",
      receivedAt: "2026-08-11T10:00:02.000Z"
    })
    ;[channel] = await database.select().from(channels).where(eq(channels.id, channelId))
    expect(channel?.optedOutAt).toBeNull()
    expect(channel?.optedInAt).toBe("2026-08-11T10:00:02.000Z")
    const resumedId = await delivery.createOutbox({
      ownerId,
      channelId,
      text: "Allowed",
      reasonCode: "test",
      correlationId,
      idempotencyKey: "test:resumed"
    })
    expect(await delivery.claimOutbox(resumedId, 60_000)).toBeDefined()
  })

  it("applies one scheduler command to the EU reminder clock alarm", async () => {
    const { database, protection, ownerKey } = await seedRunData()
    const encrypted = await protection.encryptText(ownerKey, "Future reminder")
    const dueAt = "2099-08-12T10:00:00.000Z"
    await database.batch([
      database.insert(reminders).values({
        id: "00000000-0000-4000-8000-000000000601",
        userId: ownerId,
        sourceMessageId: messageId,
        originalWordingCiphertext: encrypted.ciphertext,
        originalWordingIv: encrypted.iv,
        displayTextCiphertext: encrypted.ciphertext,
        displayTextIv: encrypted.iv,
        smsSafeTextCiphertext: encrypted.ciphertext,
        smsSafeTextIv: encrypted.iv,
        dataKeyVersion: 1,
        sensitivity: "normal",
        scheduleKind: "one_shot",
        localStartDate: "2099-08-12",
        localStartTime: "12:00",
        timeZone: "Europe/Stockholm",
        nextDueAt: dueAt,
        quietHoursBehavior: "defer",
        requiresAcknowledgment: true,
        responseDeadlineMinutes: 60,
        repeatPolicy: "none",
        maxAttempts: 1,
        channelId,
        state: "active",
        scheduleRevision: 1,
        createdAt: "2026-08-11T10:00:00.000Z",
        updatedAt: "2026-08-11T10:00:00.000Z"
      }),
      database.insert(reminderOccurrences).values({
        id: "00000000-0000-4000-8000-000000000602",
        reminderId: "00000000-0000-4000-8000-000000000601",
        sequence: 1,
        intendedDueAt: dueAt,
        localDisplayTime: "2099-08-12T12:00+02:00[Europe/Stockholm]",
        idempotencyKey: "reminder:future:one",
        state: "scheduled",
        createdAt: "2026-08-11T10:00:00.000Z",
        updatedAt: "2026-08-11T10:00:00.000Z"
      })
    ])
    // workerd does not implement jurisdiction selection. Production lookup code selects "eu".
    const namespace = env.REMINDER_CLOCK
    const stub = namespace.get(namespace.idFromName(ownerId))
    const response = await stub.fetch("https://clock.internal/command", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "00000000-0000-4000-8000-000000000603",
        reminderId: "00000000-0000-4000-8000-000000000601",
        scheduleRevision: 1,
        command: "upsert"
      })
    })
    expect(response.status).toBe(200)
    const alarm = await runInDurableObject(stub, (_instance, state) => state.storage.getAlarm())
    expect(alarm).toBe(Date.parse(dueAt))
  })

  it("rolls back journal handoff consumption when entry creation fails", async () => {
    const { database, protection } = await seedRunData()
    const ids = [
      "00000000-0000-4000-8000-000000000701",
      "00000000-0000-4000-8000-000000000702",
      "00000000-0000-4000-8000-000000000703",
      "00000000-0000-4000-8000-000000000704",
      "00000000-0000-4000-8000-000000000705"
    ]
    const journal = makeJournalStore(database, protection, {
      now: () => new Date("2026-08-11T10:00:00.000Z"),
      randomUuid: () => ids.shift()!
    })
    const handoff = await journal.createHandoff(ownerId, 60_000, "journal:handoff:atomic")
    await database.insert(searchDocuments).values({
      id: "00000000-0000-4000-8000-000000000704",
      userId: ownerId,
      sourceType: "journal_summary",
      sourceId: "00000000-0000-4000-8000-000000000703",
      text: "conflict",
      sourceLabel: "test",
      importance: 1,
      sensitivity: "private",
      modelEligible: true,
      channelEligible: false,
      createdAt: "2026-08-11T10:00:00.000Z",
      updatedAt: "2026-08-11T10:00:00.000Z"
    })
    await expect(
      journal.createEntry(
        {
          ownerId,
          handoffId: handoff.id,
          text: "Private entry",
          tags: [],
          approvedSummary: "Approved summary"
        },
        "journal:entry:atomic"
      )
    ).rejects.toThrow()
    const [storedHandoff] = await database
      .select()
      .from(journalHandoffs)
      .where(eq(journalHandoffs.id, handoff.id))
    const storedEntries = await database.select().from(journalEntries)
    expect(storedHandoff?.consumedAt).toBeNull()
    expect(storedEntries).toHaveLength(0)
  })

  it("disputes an unsupported fact when its journal source is deleted", async () => {
    const { database, protection, ownerKey } = await seedRunData()
    let next = 800
    const journal = makeJournalStore(database, protection, {
      now: () => new Date("2026-08-11T10:00:00.000Z"),
      randomUuid: () => `00000000-0000-4000-8000-${String(next++).padStart(12, "0")}`
    })
    const handoff = await journal.createHandoff(ownerId, 60_000, "journal:handoff:delete")
    const entryId = await journal.createEntry(
      {
        ownerId,
        handoffId: handoff.id,
        text: "I train on Tuesdays.",
        tags: ["training"]
      },
      "journal:entry:delete"
    )
    const factId = "00000000-0000-4000-8000-000000000810"
    const revisionId = "00000000-0000-4000-8000-000000000811"
    const canonical = await protection.encryptText(ownerKey, "Training day is Tuesday")
    await database.batch([
      database.insert(facts).values({
        id: factId,
        userId: ownerId,
        scope: "training",
        key: "training-day",
        currentRevisionId: revisionId,
        createdAt: "2026-08-11T10:00:00.000Z"
      }),
      database.insert(factRevisions).values({
        id: revisionId,
        factId,
        valueJson: JSON.stringify("Tuesday"),
        canonicalTextCiphertext: canonical.ciphertext,
        canonicalTextIv: canonical.iv,
        dataKeyVersion: 1,
        assertionKind: "user_stated",
        originClass: "owner_input",
        observedAt: "2026-08-11T10:00:00.000Z",
        extractionConfidence: 1000,
        importance: 500,
        verificationStatus: "confirmed",
        sensitivity: "normal",
        modelEligible: true,
        channelEligible: true,
        createdAt: "2026-08-11T10:00:00.000Z"
      }),
      database.insert(factEvidence).values({
        id: "00000000-0000-4000-8000-000000000812",
        revisionId,
        sourceType: "journal",
        sourceId: entryId,
        evidenceRole: "supports",
        excerptHash: "hash",
        createdAt: "2026-08-11T10:00:00.000Z"
      }),
      database.insert(factEvidence).values({
        id: "00000000-0000-4000-8000-000000000814",
        revisionId,
        sourceType: "message",
        sourceId: "contradicting-source",
        evidenceRole: "contradicts",
        excerptHash: "contradiction-hash",
        createdAt: "2026-08-11T10:00:00.000Z"
      }),
      database.insert(searchDocuments).values({
        id: "00000000-0000-4000-8000-000000000813",
        userId: ownerId,
        sourceType: "fact_revision",
        sourceId: revisionId,
        text: "Training day is Tuesday",
        sourceLabel: "journal",
        importance: 500,
        sensitivity: "normal",
        modelEligible: true,
        channelEligible: true,
        createdAt: "2026-08-11T10:00:00.000Z",
        updatedAt: "2026-08-11T10:00:00.000Z"
      })
    ])
    await journal.deleteEntry(ownerId, entryId, "journal:delete:test")
    const [revision] = await database
      .select()
      .from(factRevisions)
      .where(eq(factRevisions.id, revisionId))
    const [fact] = await database.select().from(facts).where(eq(facts.id, factId))
    const evidence = await database
      .select()
      .from(factEvidence)
      .where(eq(factEvidence.revisionId, revisionId))
    const [document] = await database
      .select()
      .from(searchDocuments)
      .where(eq(searchDocuments.sourceId, revisionId))
    expect(revision?.verificationStatus).toBe("disputed")
    expect(fact?.currentRevisionId).toBeNull()
    expect(evidence).toHaveLength(1)
    expect(evidence[0]?.evidenceRole).toBe("contradicts")
    expect(document).toMatchObject({ text: "", modelEligible: false, channelEligible: false })
    expect(document?.deletedAt).not.toBeNull()
  })

  it("keeps agent memory proposed and encrypts sensitive fact values", async () => {
    const { database, protection } = await seedRunData()
    let next = 900
    const memory = makeMemoryStore(database, protection, {
      now: () => new Date("2026-08-11T10:00:00.000Z"),
      randomUuid: () => `00000000-0000-4000-8000-${String(next++).padStart(12, "0")}`
    })
    const proposal = await memory.propose(
      {
        ownerId,
        scope: "health",
        key: "private-note",
        value: { note: "sensitive" },
        canonicalText: "A sensitive private note",
        assertionKind: "user_stated",
        originClass: "owner_input",
        sourceType: "message",
        sourceId: messageId,
        extractionConfidence: 1,
        importance: 1,
        explicitRemember: true,
        authority: "agent"
      },
      "memory:propose:test"
    )
    expect(proposal.status).toBe("proposed")
    await expect(
      memory.confirm(ownerId, proposal.candidateId, "agent" as never, "memory:confirm:invalid")
    ).rejects.toThrow("cannot confirm")
    const revisionId = await memory.confirm(
      ownerId,
      proposal.candidateId,
      "owner_ui",
      "memory:confirm:test"
    )
    const [candidate] = await database
      .select()
      .from(memoryCandidates)
      .where(eq(memoryCandidates.id, proposal.candidateId))
    const [revision] = await database
      .select()
      .from(factRevisions)
      .where(eq(factRevisions.id, revisionId))
    const indexed = await database
      .select()
      .from(searchDocuments)
      .where(eq(searchDocuments.sourceId, revisionId))
    expect(candidate).toMatchObject({ proposedValueJson: "null" })
    expect(candidate?.sensitivity).toBe("high")
    expect(candidate?.proposedValueCiphertext).not.toBeNull()
    expect(revision).toMatchObject({
      valueJson: "null",
      modelEligible: false,
      channelEligible: false
    })
    expect(revision?.valueCiphertext).not.toBeNull()
    expect(indexed).toHaveLength(0)
  })

  it("binds agent memory proposals to the current owner message", async () => {
    const { database, protection } = await seedRunData()
    const runStore = makeAgentRunStore(database, protection, {})
    await runStore.create(
      {
        protocolVersion: 1,
        runId,
        ownerId,
        correlationId,
        sourceMessageId: messageId,
        localTime: "2026-08-11T10:00:00.000Z",
        timeZone: "Europe/Stockholm",
        userText: "Remember that I prefer morning training.",
        contextItems: [],
        allowedTools: ["memory_propose"],
        limits: {
          maxTurns: 4,
          maxToolCalls: 4,
          maxDurationMs: 60_000,
          maxResponseCharacters: 1_200
        }
      },
      inboundId
    )
    expect(await runStore.claim(runId, 90_000)).toBeDefined()
    let next = 2_000
    const memory = makeMemoryStore(database, protection, {
      randomUuid: () => `00000000-0000-4000-8000-${String(next++).padStart(12, "0")}`
    })
    const executor = makeToolExecutor(
      database,
      protection,
      {
        reminders: {} as never,
        memory,
        journal: {} as never,
        training: {} as never,
        settings: {} as never
      },
      {
        uiBaseUrl: "https://bob.example.invalid",
        randomUuid: () => `00000000-0000-4000-8000-${String(next++).padStart(12, "0")}`
      }
    )

    const result = await executor.execute({
      runId,
      toolCallId: "memory-call-1",
      idempotencyKey: "memory:tool:propose",
      ownerId,
      name: "memory_propose",
      arguments: {
        scope: "preferences",
        key: "training_time",
        value: "morning",
        canonicalText: "I prefer morning training.",
        assertionKind: "user_stated",
        originClass: "background_model",
        sourceType: "assistant_claim",
        sourceId: "00000000-0000-4000-8000-999999999999",
        extractionConfidence: 0.9,
        importance: 0.8,
        explicitRemember: true
      }
    })

    expect(result).toMatchObject({ ok: true, code: "memory_proposed" })
    await expect(memory.listCandidates(ownerId)).resolves.toEqual([
      expect.objectContaining({
        originClass: "owner_input",
        sourceType: "message",
        sourceId: messageId,
        status: "proposed"
      })
    ])
  })

  it("lists memory candidates by owner and validates confirmation evidence", async () => {
    const { database, protection } = await seedRunData()
    const memory = makeMemoryStore(database, protection, {})
    const valid = await memory.propose(
      {
        ownerId,
        scope: "preferences",
        key: "training-time",
        value: "morning",
        canonicalText: "The owner prefers morning training.",
        assertionKind: "user_stated",
        originClass: "owner_input",
        sourceType: "message",
        sourceId: messageId,
        extractionConfidence: 1,
        importance: 0.8,
        explicitRemember: true,
        authority: "agent"
      },
      "memory:list:valid"
    )
    expect(await memory.listCandidates("00000000-0000-4000-8000-999999999999")).toEqual([])
    expect(await memory.listCandidates(ownerId)).toEqual([
      expect.objectContaining({
        id: valid.candidateId,
        canonicalText: "The owner prefers morning training.",
        value: "morning",
        status: "proposed"
      })
    ])
    await expect(
      memory.confirm(
        "00000000-0000-4000-8000-999999999999",
        valid.candidateId,
        "owner_ui",
        "memory:cross-owner"
      )
    ).rejects.toThrow("not found")

    const unsupported = await memory.propose(
      {
        ownerId,
        scope: "preferences",
        key: "unsupported",
        value: true,
        canonicalText: "An unsupported assistant claim.",
        assertionKind: "user_stated",
        originClass: "owner_input",
        sourceType: "assistant_claim",
        sourceId: messageId,
        extractionConfidence: 1,
        importance: 0.2,
        explicitRemember: false,
        authority: "agent"
      },
      "memory:list:unsupported"
    )
    await expect(
      memory.confirm(ownerId, unsupported.candidateId, "owner_ui", "memory:unsupported-confirm")
    ).rejects.toThrow("source type")

    const missing = await memory.propose(
      {
        ownerId,
        scope: "preferences",
        key: "missing",
        value: true,
        canonicalText: "A claim with missing evidence.",
        assertionKind: "user_stated",
        originClass: "owner_input",
        sourceType: "message",
        sourceId: "00000000-0000-4000-8000-999999999998",
        extractionConfidence: 1,
        importance: 0.2,
        explicitRemember: false,
        authority: "agent"
      },
      "memory:list:missing"
    )
    await expect(
      memory.confirm(ownerId, missing.candidateId, "owner_ui", "memory:missing-confirm")
    ).rejects.toThrow("evidence")
  })

  it("does not confirm a rejected memory candidate with a new action key", async () => {
    const { database, protection } = await seedRunData()
    let next = 2_100
    const memory = makeMemoryStore(database, protection, {
      randomUuid: () => `00000000-0000-4000-8000-${String(next++).padStart(12, "0")}`
    })
    const proposal = await memory.propose(
      {
        ownerId,
        scope: "preferences",
        key: "training_time",
        value: "morning",
        canonicalText: "I prefer morning training.",
        assertionKind: "user_stated",
        originClass: "owner_input",
        sourceType: "message",
        sourceId: messageId,
        extractionConfidence: 0.9,
        importance: 0.8,
        explicitRemember: true,
        authority: "agent"
      },
      "memory:terminal:propose"
    )

    await memory.reject(ownerId, proposal.candidateId, "memory:terminal:reject")

    await expect(
      memory.confirm(
        ownerId,
        proposal.candidateId,
        "owner_ui",
        "memory:terminal:confirm-after-reject"
      )
    ).rejects.toThrow("already reviewed")
    await expect(database.select().from(factRevisions)).resolves.toEqual([])
  })

  it("does not revise a confirmed candidate through another review action", async () => {
    const { database, protection } = await seedRunData()
    let next = 2_200
    const memory = makeMemoryStore(database, protection, {
      randomUuid: () => `00000000-0000-4000-8000-${String(next++).padStart(12, "0")}`
    })
    const proposal = await memory.propose(
      {
        ownerId,
        scope: "preferences",
        key: "training_time",
        value: "morning",
        canonicalText: "I prefer morning training.",
        assertionKind: "user_stated",
        originClass: "owner_input",
        sourceType: "message",
        sourceId: messageId,
        extractionConfidence: 0.9,
        importance: 0.8,
        explicitRemember: true,
        authority: "agent"
      },
      "memory:confirmed-terminal:propose"
    )
    const revisionId = await memory.confirm(
      ownerId,
      proposal.candidateId,
      "owner_ui",
      "memory:confirmed-terminal:confirm"
    )

    await expect(
      memory.confirm(
        ownerId,
        proposal.candidateId,
        "owner_ui",
        "memory:confirmed-terminal:confirm-again"
      )
    ).rejects.toThrow("already reviewed")
    await expect(
      memory.correct(
        ownerId,
        proposal.candidateId,
        "I prefer evening training.",
        "memory:confirmed-terminal:correct"
      )
    ).rejects.toThrow("already reviewed")
    await expect(database.select({ id: factRevisions.id }).from(factRevisions)).resolves.toEqual([
      { id: revisionId }
    ])
  })

  it("does not review an original candidate again after a correction", async () => {
    const { database, protection } = await seedRunData()
    let next = 2_250
    const memory = makeMemoryStore(database, protection, {
      randomUuid: () => `00000000-0000-4000-8000-${String(next++).padStart(12, "0")}`
    })
    const proposal = await memory.propose(
      {
        ownerId,
        scope: "preferences",
        key: "training_time",
        value: "morning",
        canonicalText: "I prefer morning training.",
        assertionKind: "user_stated",
        originClass: "owner_input",
        sourceType: "message",
        sourceId: messageId,
        extractionConfidence: 0.9,
        importance: 0.8,
        explicitRemember: true,
        authority: "agent"
      },
      "memory:correct-terminal:propose"
    )
    const replacementId = await memory.correct(
      ownerId,
      proposal.candidateId,
      "I prefer evening training.",
      "memory:correct-terminal:correct"
    )

    await expect(
      memory.confirm(
        ownerId,
        proposal.candidateId,
        "owner_ui",
        "memory:correct-terminal:confirm-old"
      )
    ).rejects.toThrow("already reviewed")
    await expect(
      memory.correct(
        ownerId,
        proposal.candidateId,
        "I prefer lunch training.",
        "memory:correct-terminal:correct-old"
      )
    ).rejects.toThrow("already reviewed")
    await expect(
      memory.reject(ownerId, proposal.candidateId, "memory:correct-terminal:reject-old")
    ).rejects.toThrow("already reviewed")
    await expect(memory.listCandidates(ownerId)).resolves.toEqual([
      expect.objectContaining({ id: replacementId, canonicalText: "I prefer evening training." })
    ])
  })

  it("lets exactly one concurrent review action claim a memory candidate", async () => {
    const { database, protection } = await seedRunData()
    let next = 2_300
    const memory = makeMemoryStore(database, protection, {
      randomUuid: () => `00000000-0000-4000-8000-${String(next++).padStart(12, "0")}`
    })
    const proposal = await memory.propose(
      {
        ownerId,
        scope: "preferences",
        key: "training_time",
        value: "morning",
        canonicalText: "I prefer morning training.",
        assertionKind: "user_stated",
        originClass: "owner_input",
        sourceType: "message",
        sourceId: messageId,
        extractionConfidence: 0.9,
        importance: 0.8,
        explicitRemember: true,
        authority: "agent"
      },
      "memory:concurrent-review:propose"
    )

    const outcomes = await Promise.allSettled([
      memory.confirm(ownerId, proposal.candidateId, "owner_ui", "memory:concurrent-review:confirm"),
      memory.correct(
        ownerId,
        proposal.candidateId,
        "I prefer evening training.",
        "memory:concurrent-review:correct"
      ),
      memory.reject(ownerId, proposal.candidateId, "memory:concurrent-review:reject")
    ])

    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1)
    const [reviewed] = await database
      .select({ status: memoryCandidates.status })
      .from(memoryCandidates)
      .where(eq(memoryCandidates.id, proposal.candidateId))
    expect(reviewed?.status === "confirmed" || reviewed?.status === "rejected").toBe(true)
    const revisions = await database.select({ id: factRevisions.id }).from(factRevisions)
    const replacements = await database
      .select({ id: memoryCandidates.id })
      .from(memoryCandidates)
      .where(eq(memoryCandidates.status, "proposed"))
    expect(revisions.length + replacements.length).toBeLessThanOrEqual(1)
  })

  it("recovers an expired tool lease without losing idempotency", async () => {
    const { database, protection } = await seedRunData()
    const runStore = makeAgentRunStore(database, protection, {
      now: () => new Date("2026-08-11T10:00:00.000Z"),
      randomUuid: () => "00000000-0000-4000-8000-000000001001"
    })
    await runStore.create(
      {
        protocolVersion: 1,
        runId,
        ownerId,
        correlationId,
        sourceMessageId: messageId,
        localTime: "2026-08-11T10:00:00.000Z",
        timeZone: "Europe/Stockholm",
        userText: "List reminders",
        contextItems: [],
        allowedTools: ["reminder_list"],
        limits: {
          maxTurns: 4,
          maxToolCalls: 4,
          maxDurationMs: 60_000,
          maxResponseCharacters: 1_200
        }
      },
      inboundId
    )
    expect(await runStore.claim(runId, 90_000)).toBeDefined()
    const leaseCommand = {
      runId,
      toolCallId: "tool-call-1",
      idempotencyKey: "tool:test:lease",
      ownerId,
      name: "reminder_list" as const,
      arguments: {}
    }
    await database.insert(toolCalls).values({
      id: "00000000-0000-4000-8000-000000001002",
      runId,
      toolCallId: "tool-call-1",
      idempotencyKey: "tool:test:lease",
      ownerId,
      toolName: "reminder_list",
      commandHash: await toolCommandHash(leaseCommand),
      argumentsJson: "encrypted-placeholder",
      status: "executing",
      claimToken: "old-claim",
      claimedAt: "2026-08-11T09:58:00.000Z",
      claimExpiresAt: "2026-08-11T09:59:00.000Z",
      attemptNumber: 1,
      createdAt: "2026-08-11T09:58:00.000Z"
    })
    let next = 1010
    const executor = makeToolExecutor(
      database,
      protection,
      {
        reminders: { list: async () => [] } as never,
        memory: {} as never,
        journal: {} as never,
        training: {} as never,
        settings: {} as never
      },
      {
        uiBaseUrl: "https://bob.example.invalid",
        now: () => new Date("2026-08-11T10:00:00.000Z"),
        randomUuid: () => `00000000-0000-4000-8000-${String(next++).padStart(12, "0")}`,
        toolLeaseMs: 60_000
      }
    )
    const result = await executor.execute(leaseCommand)
    const [attempt] = await database
      .select()
      .from(toolCalls)
      .where(eq(toolCalls.idempotencyKey, "tool:test:lease"))
    expect(result).toMatchObject({ ok: true, code: "reminder_list" })
    expect(attempt).toMatchObject({ status: "completed", attemptNumber: 2, claimToken: null })
  })

  it("lets one concurrent tool identity win an idempotency insert race", async () => {
    const { database, protection } = await seedRunData()
    const runStore = makeAgentRunStore(database, protection, {})
    await runStore.create(
      {
        protocolVersion: 1,
        runId,
        ownerId,
        correlationId,
        sourceMessageId: messageId,
        localTime: "2026-08-11T10:00:00.000Z",
        timeZone: "Europe/Stockholm",
        userText: "List reminders",
        contextItems: [],
        allowedTools: ["reminder_list"],
        limits: {
          maxTurns: 4,
          maxToolCalls: 4,
          maxDurationMs: 60_000,
          maxResponseCharacters: 1_200
        }
      },
      inboundId
    )
    expect(await runStore.claim(runId, 90_000)).toBeDefined()
    const executor = makeToolExecutor(
      database,
      protection,
      {
        reminders: { list: async () => [] } as never,
        memory: {} as never,
        journal: {} as never,
        training: {} as never,
        settings: {} as never
      },
      { uiBaseUrl: "https://bob.example.invalid" }
    )
    const first = {
      runId,
      toolCallId: "race-call-one",
      idempotencyKey: "tool:race:shared",
      ownerId,
      name: "reminder_list" as const,
      arguments: {}
    }
    const second = { ...first, toolCallId: "race-call-two" }
    const results = await Promise.all([executor.execute(first), executor.execute(second)])
    expect(results.map((result) => result.code).sort()).toEqual(["policy_denied", "reminder_list"])
    expect(
      await database
        .select()
        .from(toolCalls)
        .where(eq(toolCalls.idempotencyKey, first.idempotencyKey))
    ).toHaveLength(1)
  })

  it("enforces training ownership and stops all guidance after pain or confusion", async () => {
    const { database } = await seedRunData()
    let next = 1100
    const training = makeTrainingStore(database, {
      now: () => new Date("2026-08-11T10:00:00.000Z"),
      randomUuid: () => `00000000-0000-4000-8000-${String(next++).padStart(12, "0")}`
    })
    const gymId = await training.createGym(ownerId, "Owner gym", "training:gym:create")
    expect(await training.createGym(ownerId, "Ignored replay name", "training:gym:create")).toBe(
      gymId
    )
    expect(await database.select().from(gyms)).toHaveLength(1)
    expect(
      await database
        .select()
        .from(effectAttempts)
        .where(eq(effectAttempts.idempotencyKey, "training:gym:create"))
    ).toHaveLength(1)
    await expect(
      training.addEquipment(
        "00000000-0000-4000-8000-999999999999",
        gymId,
        "Wrong owner",
        undefined,
        "training:equipment:wrong-owner"
      )
    ).rejects.toThrow("does not belong")
    const equipmentId = await training.addEquipment(
      ownerId,
      gymId,
      "Leg press",
      "LP-1",
      "training:equipment:create"
    )
    const exerciseId = "00000000-0000-4000-8000-000000001120"
    await database.insert(exercises).values({
      id: exerciseId,
      userId: ownerId,
      name: "Leg press",
      createdAt: "2026-08-11T10:00:00.000Z"
    })
    const routineId = await training.saveRoutine(
      {
        ownerId,
        name: "Approved routine",
        approvalEvidence: { sourceType: "owner_message", sourceId: messageId },
        steps: [{ exerciseId, targetSets: 3, targetReps: 10 }]
      },
      "training:routine:save"
    )
    const [step] = await database
      .select()
      .from(routineSteps)
      .where(eq(routineSteps.routineId, routineId))
    await database.insert(equipmentExercises).values({
      id: "00000000-0000-4000-8000-000000001121",
      equipmentId,
      exerciseId,
      userApprovedAt: "2026-08-11T10:00:00.000Z",
      createdAt: "2026-08-11T10:00:00.000Z"
    })

    const painSession = await training.startWorkout(
      ownerId,
      routineId,
      gymId,
      "training:workout:pain:start"
    )
    const painStopped = await training.stopActiveForSafety(
      ownerId,
      "pain_or_injury",
      "training:workout:pain:stop"
    )
    expect(painStopped).toBe(painSession)
    await expect(
      training.logSet(
        ownerId,
        {
          sessionId: painSession,
          routineStepId: step!.id,
          equipmentId,
          sequence: 2,
          repetitions: 1
        },
        "training:workout:pain:second-set"
      )
    ).rejects.toThrow("not active")

    const confusionSession = await training.startWorkout(
      ownerId,
      routineId,
      gymId,
      "training:workout:confusion:start"
    )
    const confusionStopped = await training.stopActiveForSafety(
      ownerId,
      "machine_confusion",
      "training:workout:confusion:stop"
    )
    expect(confusionStopped).toBe(confusionSession)
    const sessions = await database.select().from(workoutSessions)
    const sets = await database.select().from(workoutSets)
    expect(sessions.every((session) => session.status === "stopped_for_safety")).toBe(true)
    expect(sets).toHaveLength(0)
  })

  it("does not start a routine without durable owner approval evidence", async () => {
    const { database } = await seedRunData()
    const routineId = "00000000-0000-4000-8000-000000001201"
    await database.insert(routines).values({
      id: routineId,
      userId: ownerId,
      name: "Unverified legacy routine",
      revision: 1,
      approvedAt: "2026-08-11T10:00:00.000Z",
      approvalSourceType: "owner_message",
      approvalSourceId: "legacy-unverified",
      createdAt: "2026-08-11T10:00:00.000Z",
      updatedAt: "2026-08-11T10:00:00.000Z"
    })
    const training = makeTrainingStore(database, {})

    await expect(
      training.startWorkout(ownerId, routineId, undefined, "training:unverified:start")
    ).rejects.toThrow("approval evidence")
    await expect(
      training.saveRoutine(
        {
          ownerId,
          name: "No owner evidence",
          approvalEvidence: { sourceType: "owner_message", sourceId: "missing-message" },
          steps: []
        },
        "training:unverified:save"
      )
    ).rejects.toThrow("approval evidence")
  })

  it("lists stable owner training IDs through bounded assistant tools", async () => {
    const { database, protection } = await seedRunData()
    const allowedTools = ["gym_list", "equipment_list", "exercise_list"] as const
    const runStore = makeAgentRunStore(database, protection, {})
    await runStore.create(
      {
        protocolVersion: 1,
        runId,
        ownerId,
        correlationId,
        sourceMessageId: messageId,
        localTime: "2026-08-11T10:00:00.000Z",
        timeZone: "Europe/Stockholm",
        userText: "Which gyms, machines, and exercises do I have?",
        contextItems: [],
        allowedTools: [...allowedTools],
        limits: {
          maxTurns: 8,
          maxToolCalls: 8,
          maxDurationMs: 60_000,
          maxResponseCharacters: 1_200
        }
      },
      inboundId
    )
    expect(await runStore.claim(runId, 90_000)).toBeDefined()
    const training = makeTrainingStore(database, {})
    const gymId = await training.createGym(ownerId, "Home gym", "lookup:gym:create")
    const exerciseId = await training.createExercise(
      ownerId,
      "Chest press",
      "Keep your back supported.",
      "lookup:exercise:create"
    )
    const equipmentId = await training.addEquipment(
      ownerId,
      gymId,
      "Chest press machine",
      "Machine 12",
      "lookup:equipment:create"
    )
    await training.mapEquipment(ownerId, equipmentId, exerciseId, "lookup:equipment:map")
    const executor = makeToolExecutor(
      database,
      protection,
      {
        reminders: {} as never,
        memory: {} as never,
        journal: {} as never,
        training,
        settings: {} as never
      },
      { uiBaseUrl: "https://bob.example.invalid" }
    )
    let call = 0
    const lookup = (name: (typeof allowedTools)[number], query?: string) => {
      call += 1
      return executor.execute({
        runId,
        toolCallId: `training-lookup-${call}`,
        idempotencyKey: `training-lookup-${call}`,
        ownerId,
        name,
        arguments: query === undefined ? {} : { query }
      })
    }

    await expect(lookup("gym_list")).resolves.toMatchObject({
      ok: true,
      code: "gym_list",
      data: { gyms: [{ id: gymId, name: "Home gym" }] }
    })
    await expect(lookup("equipment_list", "press")).resolves.toMatchObject({
      ok: true,
      code: "equipment_list",
      data: {
        equipment: [
          {
            id: equipmentId,
            name: "Chest press machine",
            identifier: "Machine 12",
            gymId,
            gymName: "Home gym",
            exerciseIds: [exerciseId]
          }
        ]
      }
    })
    await expect(lookup("exercise_list", "press")).resolves.toMatchObject({
      ok: true,
      code: "exercise_list",
      data: { exercises: [{ id: exerciseId, name: "Chest press" }] }
    })
    await expect(lookup("exercise_list", "x".repeat(101))).resolves.toMatchObject({
      ok: false,
      code: "domain_error"
    })
  })

  it("runs the complete training flow through durable owner-bound tool proposals", async () => {
    const { database, protection } = await seedRunData()
    const allowedTools = [
      "gym_create",
      "exercise_create",
      "gym_add_equipment",
      "equipment_map_exercise",
      "routine_save",
      "routine_get",
      "workout_start",
      "workout_log_set",
      "workout_finish",
      "workout_last"
    ] as const
    const runStore = makeAgentRunStore(database, protection, {})
    await runStore.create(
      {
        protocolVersion: 1,
        runId,
        ownerId,
        correlationId,
        sourceMessageId: messageId,
        localTime: "2026-08-11T10:00:00.000Z",
        timeZone: "Europe/Stockholm",
        userText: "Please set up my gym and record this workout.",
        contextItems: [],
        allowedTools: [...allowedTools],
        limits: {
          maxTurns: 20,
          maxToolCalls: 20,
          maxDurationMs: 60_000,
          maxResponseCharacters: 1_200
        }
      },
      inboundId
    )
    expect(await runStore.claim(runId, 90_000)).toBeDefined()
    const training = makeTrainingStore(database, {})
    const executor = makeToolExecutor(
      database,
      protection,
      {
        reminders: {} as never,
        memory: {} as never,
        journal: {} as never,
        training,
        settings: {} as never
      },
      { uiBaseUrl: "https://bob.example.invalid" }
    )
    let call = 0
    async function approve(name: (typeof allowedTools)[number], argumentsValue: object) {
      call += 1
      const proposed = await executor.execute({
        runId,
        toolCallId: `training-call-${call}`,
        idempotencyKey: `training-tool-${call}`,
        ownerId,
        name,
        arguments: argumentsValue
      })
      expect(proposed).toMatchObject({ ok: true, code: "training_proposed" })
      const data = proposed.data as { proposalId: string; proposalHash: string }
      await expect(
        executor.approveTrainingProposal(
          ownerId,
          data.proposalId,
          `wrong-${data.proposalHash}`,
          `owner-approval-wrong-${call}`
        )
      ).rejects.toThrow("hash")
      return executor.approveTrainingProposal(
        ownerId,
        data.proposalId,
        data.proposalHash,
        `owner-approval-${call}`
      )
    }

    const gym = await approve("gym_create", { name: "Home gym" })
    const gymId = (gym.data as { gymId: string }).gymId
    const exercise = await approve("exercise_create", {
      name: "Leg press",
      instructions: "Use a comfortable range."
    })
    const exerciseId = (exercise.data as { exerciseId: string }).exerciseId
    const item = await approve("gym_add_equipment", {
      gymId,
      name: "Leg press machine",
      identifier: "LP-1"
    })
    const equipmentId = (item.data as { equipmentId: string }).equipmentId
    await approve("equipment_map_exercise", { equipmentId, exerciseId })
    const saved = await approve("routine_save", {
      name: "Tuesday strength",
      steps: [{ exerciseId, targetSets: 3, targetReps: 10 }]
    })
    const routineId = (saved.data as { routineId: string }).routineId

    call += 1
    const routine = await executor.execute({
      runId,
      toolCallId: `training-call-${call}`,
      idempotencyKey: `training-tool-${call}`,
      ownerId,
      name: "routine_get",
      arguments: { id: routineId }
    })
    expect(routine).toMatchObject({
      ok: true,
      code: "routine_found",
      data: { routine: { id: routineId, name: "Tuesday strength" } }
    })
    const routineStepId = (routine.data as { routine: { steps: readonly { id: string }[] } })
      .routine.steps[0]!.id

    const started = await approve("workout_start", { routineId, gymId })
    const sessionId = (started.data as { sessionId: string }).sessionId
    await approve("workout_log_set", {
      sessionId,
      routineStepId,
      equipmentId,
      sequence: 1,
      repetitions: 10,
      weightGrams: 40_000
    })
    await approve("workout_finish", { id: sessionId })

    call += 1
    const last = await executor.execute({
      runId,
      toolCallId: `training-call-${call}`,
      idempotencyKey: `training-tool-${call}`,
      ownerId,
      name: "workout_last",
      arguments: { routineId }
    })
    expect(last).toMatchObject({
      ok: true,
      code: "workout_last",
      data: {
        workout: {
          id: sessionId,
          status: "completed",
          sets: [{ repetitions: 10, weightGrams: 40_000 }]
        }
      }
    })
    const proposals = await executor.listTrainingProposals(ownerId)
    expect(proposals).toHaveLength(8)
    expect(proposals.every((proposal) => proposal.status === "applied")).toBe(true)
    expect(await database.select().from(trainingProposals)).toHaveLength(8)
  })

  it("recovers owner approval after a training mutation commits before its result", async () => {
    const { database, protection } = await seedRunData()
    const runStore = makeAgentRunStore(database, protection, {})
    await runStore.create(
      {
        protocolVersion: 1,
        runId,
        ownerId,
        correlationId,
        sourceMessageId: messageId,
        localTime: "2026-08-11T10:00:00.000Z",
        timeZone: "Europe/Stockholm",
        userText: "Please add my recovery gym.",
        contextItems: [],
        allowedTools: ["gym_create"],
        limits: {
          maxTurns: 4,
          maxToolCalls: 4,
          maxDurationMs: 60_000,
          maxResponseCharacters: 1_200
        }
      },
      inboundId
    )
    expect(await runStore.claim(runId, 90_000)).toBeDefined()
    const training = makeTrainingStore(database, {})
    const executor = makeToolExecutor(
      database,
      protection,
      {
        reminders: {} as never,
        memory: {} as never,
        journal: {} as never,
        training,
        settings: {} as never
      },
      { uiBaseUrl: "https://bob.example.invalid" }
    )
    const command = {
      runId,
      toolCallId: "crash-call",
      idempotencyKey: "training:crash:command",
      ownerId,
      name: "gym_create" as const,
      arguments: { name: "Recovery gym" }
    }
    const proposed = await executor.execute(command)
    const proposal = proposed.data as { proposalId: string; proposalHash: string }
    const gymId = await training.createGym(ownerId, "Recovery gym", command.idempotencyKey)
    await database
      .update(trainingProposals)
      .set({
        status: "applying",
        approvalIdempotencyKey: "owner:crash:approval",
        approvedAt: "2026-08-11T10:00:00.000Z"
      })
      .where(eq(trainingProposals.id, proposal.proposalId))

    const recovered = await executor.approveTrainingProposal(
      ownerId,
      proposal.proposalId,
      proposal.proposalHash,
      "owner:crash:approval"
    )
    expect(recovered).toMatchObject({ ok: true, code: "gym_created", data: { gymId } })
    expect(await database.select().from(gyms)).toHaveLength(1)
    expect(await database.select().from(effectAttempts)).toHaveLength(1)
  })
})
