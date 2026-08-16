import type { CurrentTurnMessage } from "@bob/contracts/agent"

import { transitionalDeploymentProfile } from "@bob/contracts/deployment-profiles"
import {
  conversationMutationIdempotencyKey as hashMutation,
  type ToolName
} from "@bob/contracts/tools"
import { applyD1Migrations, reset } from "cloudflare:test"
import { env } from "cloudflare:workers"
import { eq } from "drizzle-orm"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { createCoreDatabase } from "../src/database.ts"
import { makeAgentRunStore } from "../src/modules/conversations/run-store.ts"
import {
  channels,
  conversationTurns,
  inboundEvents,
  messages,
  toolCalls,
  users
} from "../src/modules/conversations/schema.ts"
import { toolCommandHash } from "../src/modules/conversations/tool-executor.ts"
import { createDataProtection } from "../src/modules/policy/data-protection.ts"
import { decodeTestMigrations } from "./migrations.ts"
import { makeTestToolExecutor } from "./tool-executor-fixture.ts"

declare global {
  namespace Cloudflare {
    interface Env {
      DB: D1Database
      TEST_MIGRATIONS: string
    }
  }
}

const ownerId = "00000000-0000-4000-8000-000000002001"
const channelId = "00000000-0000-4000-8000-000000002002"
const inboundId = "00000000-0000-4000-8000-000000002003"
const messageId = "00000000-0000-4000-8000-000000002004"
const runId = "00000000-0000-4000-8000-000000002005"
const correlationId = "00000000-0000-4000-8000-000000002006"
const turnId = "00000000-0000-4000-8000-000000002007"
const secondMessageId = "00000000-0000-4000-8000-000000002008"
const secondInboundId = "00000000-0000-4000-8000-000000002009"
const secondRunId = "00000000-0000-4000-8000-000000002010"
const at = "2026-08-11T10:00:00.000Z"

async function conversationMutationIdempotencyKey(
  input: Parameters<typeof hashMutation>[0]
): Promise<string> {
  return hashMutation({
    ...input,
    excludedArgumentNames: transitionalDeploymentProfile.mutationArgumentExclusions(input.toolName)
  })
}

function key(byte: number): string {
  let binary = ""
  for (const value of new Uint8Array(32).fill(byte)) binary += String.fromCharCode(value)
  return btoa(binary)
}

async function seedActiveConversationRun(
  userText = "List reminders",
  allowedTools: readonly ToolName[] = ["reminder_list"],
  currentTurnMessages: readonly CurrentTurnMessage[] = [
    { sourceMessageId: messageId, text: userText }
  ]
) {
  const database = createCoreDatabase(env.DB)
  const protection = createDataProtection({ 1: key(1) }, 1, key(2))
  const wrapped = await protection.createWrappedDataKey()
  const sender = await protection.encryptText(wrapped.key, "+46700000000")
  const destination = await protection.encryptText(wrapped.key, "+46711111111")
  const inboundText = await protection.encryptText(wrapped.key, userText)
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
    }),
    database.insert(conversationTurns).values({
      id: turnId,
      userId: ownerId,
      channelId,
      status: "running",
      revision: 1,
      latestInboundEventId: inboundId,
      latestMessageId: messageId,
      activeRunId: runId,
      activeRunRevision: 1,
      claimedRevision: 1,
      claimedAt: at,
      claimExpiresAt: "2026-08-11T10:02:00.000Z",
      quietUntil: at,
      burstExpiresAt: "2026-08-11T10:05:00.000Z",
      createdAt: at,
      updatedAt: at
    })
  ])
  const runs = makeAgentRunStore(database, protection, { now: () => new Date(at) })
  await runs.create(
    {
      protocolVersion: 1,
      runId,
      ownerId,
      correlationId,
      conversationTurnId: turnId,
      conversationTurnRevision: 1,
      sourceMessageId: messageId,
      localTime: at,
      timeZone: "Europe/Stockholm",
      userText,
      currentTurnMessages: [...currentTurnMessages],
      contextItems: [],
      allowedTools: [...allowedTools],
      limits: {
        maxTurns: 4,
        maxToolCalls: 4,
        maxDurationMs: 60_000,
        maxResponseCharacters: 1_200
      }
    },
    inboundId
  )
  expect(await runs.claim(runId, 90_000)).toBeDefined()
  return { database, protection, ownerKey: wrapped.key }
}

async function activateSecondConversationRun(
  seeded: Awaited<ReturnType<typeof seedActiveConversationRun>>,
  userText: string,
  allowedTools: readonly ToolName[]
) {
  const secondText = await seeded.protection.encryptText(seeded.ownerKey, userText)
  await seeded.database.batch([
    seeded.database.insert(messages).values({
      id: secondMessageId,
      userId: ownerId,
      channelId,
      direction: "inbound",
      textCiphertext: secondText.ciphertext,
      textIv: secondText.iv,
      dataKeyVersion: 1,
      occurredAt: "2026-08-11T10:00:01.000Z",
      createdAt: "2026-08-11T10:00:01.000Z"
    }),
    seeded.database.insert(inboundEvents).values({
      id: secondInboundId,
      userId: ownerId,
      channelId,
      messageId: secondMessageId,
      accountId: "account",
      lineId: "line",
      providerMessageHandle: "provider-handle-two",
      correlationId: "00000000-0000-4000-8000-000000002011",
      createdAt: "2026-08-11T10:00:01.000Z"
    }),
    seeded.database
      .update(conversationTurns)
      .set({
        status: "running",
        revision: 2,
        latestInboundEventId: secondInboundId,
        latestMessageId: secondMessageId,
        activeRunId: secondRunId,
        activeRunRevision: 2,
        claimedRevision: 2,
        updatedAt: "2026-08-11T10:00:01.000Z"
      })
      .where(eq(conversationTurns.id, turnId))
  ])
  const runs = makeAgentRunStore(seeded.database, seeded.protection, {
    now: () => new Date(at)
  })
  await runs.create(
    {
      protocolVersion: 1,
      runId: secondRunId,
      ownerId,
      correlationId: "00000000-0000-4000-8000-000000002011",
      conversationTurnId: turnId,
      conversationTurnRevision: 2,
      sourceMessageId: secondMessageId,
      localTime: at,
      timeZone: "Europe/Stockholm",
      userText,
      currentTurnMessages: [{ sourceMessageId: secondMessageId, text: userText }],
      contextItems: [],
      allowedTools: [...allowedTools],
      limits: {
        maxTurns: 4,
        maxToolCalls: 4,
        maxDurationMs: 60_000,
        maxResponseCharacters: 1_200
      }
    },
    secondInboundId
  )
  expect(await runs.claim(secondRunId, 90_000)).toBeDefined()
}

function makeExecutor(
  database: ReturnType<typeof createCoreDatabase>,
  protection: ReturnType<typeof createDataProtection>,
  list: () => Promise<readonly never[]>
) {
  return makeTestToolExecutor(
    database,
    protection,
    {
      // SAFETY: This controlled test fixture matches the asserted contract used by this test.
      reminders: { list } as never,
      // SAFETY: This controlled test fixture matches the asserted contract used by this test.
      memory: {} as never,
      // SAFETY: This controlled test fixture matches the asserted contract used by this test.
      journal: {} as never,
      // SAFETY: This controlled test fixture matches the asserted contract used by this test.
      training: {} as never,
      // SAFETY: This controlled test fixture matches the asserted contract used by this test.
      settings: {} as never
    },
    { uiBaseUrl: "https://bob.example.invalid", now: () => new Date(at) }
  )
}

function listCommand(suffix: string) {
  return {
    runId,
    toolCallId: `${suffix}-tool-call`,
    idempotencyKey: `tool:test:${suffix}`,
    ownerId,
    name: "reminder_list" as const,
    arguments: {}
  }
}

function reminderArguments(sourceMessageId: string) {
  return {
    displayText: "Lunch",
    smsSafeText: "Lunch",
    localDate: "2026-08-12",
    localTime: "13:00",
    timeZone: "Europe/Stockholm",
    dueAt: "2026-08-12T11:00:00.000Z",
    sourceMessageId
  } as const
}

beforeEach(async () => {
  await applyD1Migrations(env.DB, decodeTestMigrations(env.TEST_MIGRATIONS))
})

afterEach(async () => {
  await reset()
})

describe("conversation tool claim fence", () => {
  it.each(["Cancel it.", "Stop this reminder."])(
    "allows one direct single-message cancellation: %s",
    async (userText) => {
      const seeded = await seedActiveConversationRun(userText, ["reminder_cancel"])
      const reminderId = "00000000-0000-4000-8000-000000002016"
      const argumentsValue = { reminderId }
      const idempotencyKey = await conversationMutationIdempotencyKey({
        ownerId,
        conversationTurnId: turnId,
        toolName: "reminder_cancel",
        arguments: argumentsValue
      })
      let cancelCalls = 0
      const executor = makeTestToolExecutor(
        seeded.database,
        seeded.protection,
        {
          // SAFETY: This controlled test fixture matches the asserted contract used by this test.
          reminders: {
            list: async () => [
              {
                id: reminderId,
                displayText: "Lunch",
                state: "active",
                actionTargets: []
              }
            ],
            cancel: async () => {
              cancelCalls += 1
            }
          } as never,
          // SAFETY: This controlled test fixture matches the asserted contract used by this test.
          memory: {} as never,
          // SAFETY: This controlled test fixture matches the asserted contract used by this test.
          journal: {} as never,
          // SAFETY: This controlled test fixture matches the asserted contract used by this test.
          training: {} as never,
          // SAFETY: This controlled test fixture matches the asserted contract used by this test.
          settings: {} as never
        },
        { uiBaseUrl: "https://bob.example.invalid", now: () => new Date(at) }
      )

      await expect(
        executor.execute({
          runId,
          toolCallId: "single-message-cancel-call",
          idempotencyKey,
          ownerId,
          name: "reminder_cancel",
          arguments: argumentsValue
        })
      ).resolves.toMatchObject({ ok: true, code: "reminder_cancelled" })
      expect(cancelCalls).toBe(1)
    }
  )

  it("uses earlier details and a safe latest correction for reminder mutation policy", async () => {
    const latestText = "Actually at 08:00"
    const seeded = await seedActiveConversationRun(
      latestText,
      ["reminder_create"],
      [
        {
          sourceMessageId: "00000000-0000-4000-8000-000000002014",
          text: "Remind me tomorrow"
        },
        { sourceMessageId: messageId, text: latestText }
      ]
    )
    const argumentsValue = {
      ...reminderArguments(messageId),
      localTime: "08:00",
      dueAt: "2026-08-12T06:00:00.000Z"
    }
    const idempotencyKey = await conversationMutationIdempotencyKey({
      ownerId,
      conversationTurnId: turnId,
      toolName: "reminder_create",
      arguments: argumentsValue
    })
    let createCalls = 0
    const executor = makeTestToolExecutor(
      seeded.database,
      seeded.protection,
      {
        // SAFETY: This controlled test fixture matches the asserted contract used by this test.
        reminders: {
          createOneShot: async () => {
            createCalls += 1
            return {
              reminderId: "00000000-0000-4000-8000-000000002012",
              occurrenceId: "00000000-0000-4000-8000-000000002013",
              localDisplayTime: "2026-08-12T08:00+02:00[Europe/Stockholm]",
              duplicate: false
            }
          }
        } as never,
        // SAFETY: This controlled test fixture matches the asserted contract used by this test.
        memory: {} as never,
        // SAFETY: This controlled test fixture matches the asserted contract used by this test.
        journal: {} as never,
        // SAFETY: This controlled test fixture matches the asserted contract used by this test.
        training: {} as never,
        // SAFETY: This controlled test fixture matches the asserted contract used by this test.
        settings: {} as never
      },
      { uiBaseUrl: "https://bob.example.invalid", now: () => new Date(at) }
    )

    await expect(
      executor.execute({
        runId,
        toolCallId: "fragmented-reminder-call",
        idempotencyKey,
        ownerId,
        name: "reminder_create",
        arguments: argumentsValue
      })
    ).resolves.toMatchObject({ ok: true, code: "reminder_created" })
    expect(createCalls).toBe(1)
  })

  it("allows a direct mutation question in the latest fragment", async () => {
    const latestText = "Can you remind me tomorrow at 13:00?"
    const seeded = await seedActiveConversationRun(
      latestText,
      ["reminder_create"],
      [
        {
          sourceMessageId: "00000000-0000-4000-8000-000000002014",
          text: "Lunch is important."
        },
        { sourceMessageId: messageId, text: latestText }
      ]
    )
    const argumentsValue = reminderArguments(messageId)
    let createCalls = 0
    const executor = makeTestToolExecutor(
      seeded.database,
      seeded.protection,
      {
        // SAFETY: This controlled test fixture matches the asserted contract used by this test.
        reminders: {
          createOneShot: async () => {
            createCalls += 1
            return {
              reminderId: "00000000-0000-4000-8000-000000002019",
              occurrenceId: "00000000-0000-4000-8000-000000002020",
              localDisplayTime: "2026-08-12T13:00+02:00[Europe/Stockholm]",
              duplicate: false
            }
          }
        } as never,
        // SAFETY: This controlled test fixture matches the asserted contract used by this test.
        memory: {} as never,
        // SAFETY: This controlled test fixture matches the asserted contract used by this test.
        journal: {} as never,
        // SAFETY: This controlled test fixture matches the asserted contract used by this test.
        training: {} as never,
        // SAFETY: This controlled test fixture matches the asserted contract used by this test.
        settings: {} as never
      },
      { uiBaseUrl: "https://bob.example.invalid", now: () => new Date(at) }
    )

    await expect(
      executor.execute({
        runId,
        toolCallId: "direct-question-reminder-call",
        idempotencyKey: await conversationMutationIdempotencyKey({
          ownerId,
          conversationTurnId: turnId,
          toolName: "reminder_create",
          arguments: argumentsValue
        }),
        ownerId,
        name: "reminder_create",
        arguments: argumentsValue
      })
    ).resolves.toMatchObject({ ok: true, code: "reminder_created" })
    expect(createCalls).toBe(1)
  })

  it.each(["Never mind.", "Can you not do that?", "Glöm det.", "Kan du inte göra det?"])(
    "does not let an earlier fragment authorize a retracted mutation: %s",
    async (latestText) => {
      const seeded = await seedActiveConversationRun(
        latestText,
        ["reminder_create"],
        [
          {
            sourceMessageId: "00000000-0000-4000-8000-000000002014",
            text: "Remind me tomorrow at 13:00."
          },
          { sourceMessageId: messageId, text: latestText }
        ]
      )
      const argumentsValue = reminderArguments(messageId)
      const idempotencyKey = await conversationMutationIdempotencyKey({
        ownerId,
        conversationTurnId: turnId,
        toolName: "reminder_create",
        arguments: argumentsValue
      })
      let createCalls = 0
      const executor = makeTestToolExecutor(
        seeded.database,
        seeded.protection,
        {
          // SAFETY: This controlled test fixture matches the asserted contract used by this test.
          reminders: {
            createOneShot: async () => {
              createCalls += 1
              // SAFETY: This controlled test fixture matches the asserted contract used by this test.
              return {} as never
            }
          } as never,
          // SAFETY: This controlled test fixture matches the asserted contract used by this test.
          memory: {} as never,
          // SAFETY: This controlled test fixture matches the asserted contract used by this test.
          journal: {} as never,
          // SAFETY: This controlled test fixture matches the asserted contract used by this test.
          training: {} as never,
          // SAFETY: This controlled test fixture matches the asserted contract used by this test.
          settings: {} as never
        },
        { uiBaseUrl: "https://bob.example.invalid", now: () => new Date(at) }
      )

      await expect(
        executor.execute({
          runId,
          toolCallId: "retracted-reminder-call",
          idempotencyKey,
          ownerId,
          name: "reminder_create",
          arguments: argumentsValue
        })
      ).resolves.toMatchObject({ ok: false, code: "policy_denied" })
      expect(createCalls).toBe(0)
    }
  )

  it("allows a later explicit instruction after an earlier revision denies the mutation", async () => {
    const retraction = "Never mind."
    const seeded = await seedActiveConversationRun(
      retraction,
      ["reminder_create"],
      [
        {
          sourceMessageId: "00000000-0000-4000-8000-000000002014",
          text: "Remind me tomorrow at 13:00."
        },
        { sourceMessageId: messageId, text: retraction }
      ]
    )
    const firstArguments = reminderArguments(messageId)
    const idempotencyKey = await conversationMutationIdempotencyKey({
      ownerId,
      conversationTurnId: turnId,
      toolName: "reminder_create",
      arguments: firstArguments
    })
    let createCalls = 0
    const executor = makeTestToolExecutor(
      seeded.database,
      seeded.protection,
      {
        // SAFETY: This controlled test fixture matches the asserted contract used by this test.
        reminders: {
          createOneShot: async () => {
            createCalls += 1
            return {
              reminderId: "00000000-0000-4000-8000-000000002017",
              occurrenceId: "00000000-0000-4000-8000-000000002018",
              localDisplayTime: "2026-08-12T13:00+02:00[Europe/Stockholm]",
              duplicate: false
            }
          }
        } as never,
        // SAFETY: This controlled test fixture matches the asserted contract used by this test.
        memory: {} as never,
        // SAFETY: This controlled test fixture matches the asserted contract used by this test.
        journal: {} as never,
        // SAFETY: This controlled test fixture matches the asserted contract used by this test.
        training: {} as never,
        // SAFETY: This controlled test fixture matches the asserted contract used by this test.
        settings: {} as never
      },
      { uiBaseUrl: "https://bob.example.invalid", now: () => new Date(at) }
    )
    await expect(
      executor.execute({
        runId,
        toolCallId: "retracted-then-authorized-call",
        idempotencyKey,
        ownerId,
        name: "reminder_create",
        arguments: firstArguments
      })
    ).resolves.toMatchObject({ ok: false, code: "policy_denied" })
    const [turnAfterDenial] = await seeded.database
      .select({ mutationIdempotencyKey: conversationTurns.mutationIdempotencyKey })
      .from(conversationTurns)
      .where(eq(conversationTurns.id, turnId))
    expect(turnAfterDenial?.mutationIdempotencyKey).toBeNull()
    await expect(seeded.database.select().from(toolCalls)).resolves.toEqual([])

    await activateSecondConversationRun(seeded, "Remind me tomorrow at 13:00.", ["reminder_create"])
    await expect(
      executor.execute({
        runId: secondRunId,
        toolCallId: "explicitly-authorized-call",
        idempotencyKey,
        ownerId,
        name: "reminder_create",
        arguments: reminderArguments(secondMessageId)
      })
    ).resolves.toMatchObject({ ok: true, code: "reminder_created" })
    expect(createCalls).toBe(1)
  })

  it.each([
    "Wait, what will that change?",
    "What will that change?",
    "Can you explain what that will change?",
    "At 8?"
  ])(
    "does not let an earlier fragment authorize a mutation while the latest fragment asks for review: %s",
    async (latestText) => {
      const seeded = await seedActiveConversationRun(
        latestText,
        ["reminder_create"],
        [
          {
            sourceMessageId: "00000000-0000-4000-8000-000000002014",
            text: "Remind me tomorrow at 13:00."
          },
          { sourceMessageId: messageId, text: latestText }
        ]
      )
      const argumentsValue = reminderArguments(messageId)
      const idempotencyKey = await conversationMutationIdempotencyKey({
        ownerId,
        conversationTurnId: turnId,
        toolName: "reminder_create",
        arguments: argumentsValue
      })
      let createCalls = 0
      const executor = makeTestToolExecutor(
        seeded.database,
        seeded.protection,
        {
          // SAFETY: This controlled test fixture matches the asserted contract used by this test.
          reminders: {
            createOneShot: async () => {
              createCalls += 1
              // SAFETY: This controlled test fixture matches the asserted contract used by this test.
              return {} as never
            }
          } as never,
          // SAFETY: This controlled test fixture matches the asserted contract used by this test.
          memory: {} as never,
          // SAFETY: This controlled test fixture matches the asserted contract used by this test.
          journal: {} as never,
          // SAFETY: This controlled test fixture matches the asserted contract used by this test.
          training: {} as never,
          // SAFETY: This controlled test fixture matches the asserted contract used by this test.
          settings: {} as never
        },
        { uiBaseUrl: "https://bob.example.invalid", now: () => new Date(at) }
      )

      await expect(
        executor.execute({
          runId,
          toolCallId: "reviewing-reminder-call",
          idempotencyKey,
          ownerId,
          name: "reminder_create",
          arguments: argumentsValue
        })
      ).resolves.toMatchObject({ ok: false, code: "policy_denied" })
      expect(createCalls).toBe(0)
    }
  )

  it("replays one terminal mutation result across conversation turn revisions", async () => {
    const userText = "Set my time zone to America/New_York and use 24-hour time."
    const seeded = await seedActiveConversationRun(userText, ["settings_update"])
    const { database, protection } = seeded
    const argumentsValue = { timeZone: "America/New_York", hourCycle: "h23" } as const
    const idempotencyKey = await conversationMutationIdempotencyKey({
      ownerId,
      conversationTurnId: turnId,
      toolName: "settings_update",
      arguments: argumentsValue
    })
    let updateCalls = 0
    const executor = makeTestToolExecutor(
      database,
      protection,
      {
        // SAFETY: This controlled test fixture matches the asserted contract used by this test.
        reminders: {} as never,
        // SAFETY: This controlled test fixture matches the asserted contract used by this test.
        memory: {} as never,
        // SAFETY: This controlled test fixture matches the asserted contract used by this test.
        journal: {} as never,
        // SAFETY: This controlled test fixture matches the asserted contract used by this test.
        training: {} as never,
        // SAFETY: This controlled test fixture matches the asserted contract used by this test.
        settings: {
          update: async () => {
            updateCalls += 1
            return {
              timeZone: "America/New_York",
              locale: "en",
              hourCycle: "h23"
            }
          }
        } as never
      },
      { uiBaseUrl: "https://bob.example.invalid", now: () => new Date(at) }
    )
    const firstResult = await executor.execute({
      runId,
      toolCallId: "revision-one-settings-call",
      idempotencyKey,
      ownerId,
      name: "settings_update",
      arguments: argumentsValue
    })
    expect(firstResult).toMatchObject({ ok: true, code: "owner_settings_updated" })
    expect(updateCalls).toBe(1)

    await activateSecondConversationRun(seeded, userText, ["settings_update"])

    const replay = await executor.execute({
      runId: secondRunId,
      toolCallId: "revision-two-settings-call",
      idempotencyKey,
      ownerId,
      name: "settings_update",
      arguments: { hourCycle: "h23", timeZone: "America/New_York" }
    })

    expect(replay).toEqual(firstResult)
    expect(updateCalls).toBe(1)
    await expect(executor.mutationActivity(secondRunId)).resolves.toEqual({
      status: "completed",
      completedInRun: true
    })
    const [receipt] = await database
      .select({ runId: toolCalls.runId, toolCallId: toolCalls.toolCallId })
      .from(toolCalls)
      .where(eq(toolCalls.idempotencyKey, idempotencyKey))
    expect(receipt).toEqual({
      runId: secondRunId,
      toolCallId: "revision-two-settings-call"
    })
  })

  it("requires a new confirmation before a second distinct successful mutation in one turn", async () => {
    const userText = "Set my time zone to America/New_York, then set my time zone to Europe/London."
    const seeded = await seedActiveConversationRun(userText, ["settings_update"])
    let updateCalls = 0
    const executor = makeTestToolExecutor(
      seeded.database,
      seeded.protection,
      {
        // SAFETY: This controlled test fixture matches the asserted contract used by this test.
        reminders: {} as never,
        // SAFETY: This controlled test fixture matches the asserted contract used by this test.
        memory: {} as never,
        // SAFETY: This controlled test fixture matches the asserted contract used by this test.
        journal: {} as never,
        // SAFETY: This controlled test fixture matches the asserted contract used by this test.
        training: {} as never,
        // SAFETY: This controlled test fixture matches the asserted contract used by this test.
        settings: {
          update: async (_ownerId: string, input: { readonly timeZone?: string }) => {
            updateCalls += 1
            return {
              timeZone: input.timeZone ?? "Europe/Stockholm",
              locale: "en",
              hourCycle: "h23"
            }
          }
        } as never
      },
      { uiBaseUrl: "https://bob.example.invalid", now: () => new Date(at) }
    )
    const firstArguments = { timeZone: "America/New_York" }
    const firstKey = await conversationMutationIdempotencyKey({
      ownerId,
      conversationTurnId: turnId,
      toolName: "settings_update",
      arguments: firstArguments
    })
    await expect(
      executor.execute({
        runId,
        toolCallId: "first-distinct-settings-call",
        idempotencyKey: firstKey,
        ownerId,
        name: "settings_update",
        arguments: firstArguments
      })
    ).resolves.toMatchObject({ ok: true, code: "owner_settings_updated" })

    const secondArguments = { timeZone: "Europe/London" }
    const secondKey = await conversationMutationIdempotencyKey({
      ownerId,
      conversationTurnId: turnId,
      toolName: "settings_update",
      arguments: secondArguments
    })
    await expect(
      executor.execute({
        runId,
        toolCallId: "second-distinct-settings-call",
        idempotencyKey: secondKey,
        ownerId,
        name: "settings_update",
        arguments: secondArguments
      })
    ).resolves.toMatchObject({ ok: false, code: "confirmation_required" })
    expect(updateCalls).toBe(1)
  })

  it("does not dispatch a distinct mutation while one mutation in the turn is active", async () => {
    const userText = "Set my time zone to America/New_York, then set my time zone to Europe/London."
    const seeded = await seedActiveConversationRun(userText, ["settings_update"])
    let releaseFirst!: () => void
    const firstMayFinish = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    let markFirstStarted!: () => void
    const firstStarted = new Promise<void>((resolve) => {
      markFirstStarted = resolve
    })
    let updateCalls = 0
    const executor = makeTestToolExecutor(
      seeded.database,
      seeded.protection,
      {
        // SAFETY: This controlled test fixture matches the asserted contract used by this test.
        reminders: {} as never,
        // SAFETY: This controlled test fixture matches the asserted contract used by this test.
        memory: {} as never,
        // SAFETY: This controlled test fixture matches the asserted contract used by this test.
        journal: {} as never,
        // SAFETY: This controlled test fixture matches the asserted contract used by this test.
        training: {} as never,
        // SAFETY: This controlled test fixture matches the asserted contract used by this test.
        settings: {
          update: async (_ownerId: string, input: { readonly timeZone?: string }) => {
            updateCalls += 1
            if (updateCalls === 1) {
              markFirstStarted()
              await firstMayFinish
            }
            return {
              timeZone: input.timeZone ?? "Europe/Stockholm",
              locale: "en",
              hourCycle: "h23"
            }
          }
        } as never
      },
      { uiBaseUrl: "https://bob.example.invalid", now: () => new Date(at) }
    )
    const firstArguments = { timeZone: "America/New_York" }
    const firstPromise = executor.execute({
      runId,
      toolCallId: "active-first-settings-call",
      idempotencyKey: await conversationMutationIdempotencyKey({
        ownerId,
        conversationTurnId: turnId,
        toolName: "settings_update",
        arguments: firstArguments
      }),
      ownerId,
      name: "settings_update",
      arguments: firstArguments
    })
    await firstStarted

    const secondArguments = { timeZone: "Europe/London" }
    await expect(
      executor.execute({
        runId,
        toolCallId: "active-second-settings-call",
        idempotencyKey: await conversationMutationIdempotencyKey({
          ownerId,
          conversationTurnId: turnId,
          toolName: "settings_update",
          arguments: secondArguments
        }),
        ownerId,
        name: "settings_update",
        arguments: secondArguments
      })
    ).resolves.toMatchObject({ ok: false, code: "confirmation_required" })
    expect(updateCalls).toBe(1)

    releaseFirst()
    await expect(firstPromise).resolves.toMatchObject({ ok: true, code: "owner_settings_updated" })
  })

  it("lets only one distinct mutation claim a conversation turn concurrently", async () => {
    const userText = "Set my time zone to America/New_York, then set my time zone to Europe/London."
    const seeded = await seedActiveConversationRun(userText, ["settings_update"])
    let updateCalls = 0
    const executor = makeTestToolExecutor(
      seeded.database,
      seeded.protection,
      {
        // SAFETY: This controlled test fixture matches the asserted contract used by this test.
        reminders: {} as never,
        // SAFETY: This controlled test fixture matches the asserted contract used by this test.
        memory: {} as never,
        // SAFETY: This controlled test fixture matches the asserted contract used by this test.
        journal: {} as never,
        // SAFETY: This controlled test fixture matches the asserted contract used by this test.
        training: {} as never,
        // SAFETY: This controlled test fixture matches the asserted contract used by this test.
        settings: {
          update: async (_ownerId: string, input: { readonly timeZone?: string }) => {
            updateCalls += 1
            return {
              timeZone: input.timeZone ?? "Europe/Stockholm",
              locale: "en",
              hourCycle: "h23"
            }
          }
        } as never
      },
      { uiBaseUrl: "https://bob.example.invalid", now: () => new Date(at) }
    )
    const commands = await Promise.all(
      ["America/New_York", "Europe/London"].map(async (timeZone, index) => ({
        runId,
        toolCallId: `concurrent-distinct-settings-call-${index}`,
        idempotencyKey: await conversationMutationIdempotencyKey({
          ownerId,
          conversationTurnId: turnId,
          toolName: "settings_update",
          arguments: { timeZone }
        }),
        ownerId,
        name: "settings_update" as const,
        arguments: { timeZone }
      }))
    )

    const results = await Promise.all(commands.map((command) => executor.execute(command)))

    expect(results.filter((result) => result.ok)).toHaveLength(1)
    expect(results.filter((result) => result.code === "confirmation_required")).toHaveLength(1)
    expect(updateCalls).toBe(1)
    await expect(executor.mutationActivity(runId)).resolves.toEqual({
      status: "completed",
      completedInRun: true
    })
    const winningIndex = results.findIndex((result) => result.ok)
    const [turn] = await seeded.database
      .select({ mutationIdempotencyKey: conversationTurns.mutationIdempotencyKey })
      .from(conversationTurns)
      .where(eq(conversationTurns.id, turnId))
    expect(turn?.mutationIdempotencyKey).toBe(commands[winningIndex]?.idempotencyKey)
  })

  it("reports mutation activity across revisions of the same conversation turn", async () => {
    const userText = "Set my time zone to America/New_York."
    const seeded = await seedActiveConversationRun(userText, ["settings_update"])
    let releaseMutation!: () => void
    const mutationMayFinish = new Promise<void>((resolve) => {
      releaseMutation = resolve
    })
    let markMutationStarted!: () => void
    const mutationStarted = new Promise<void>((resolve) => {
      markMutationStarted = resolve
    })
    const executor = makeTestToolExecutor(
      seeded.database,
      seeded.protection,
      {
        // SAFETY: This controlled test fixture matches the asserted contract used by this test.
        reminders: {} as never,
        // SAFETY: This controlled test fixture matches the asserted contract used by this test.
        memory: {} as never,
        // SAFETY: This controlled test fixture matches the asserted contract used by this test.
        journal: {} as never,
        // SAFETY: This controlled test fixture matches the asserted contract used by this test.
        training: {} as never,
        // SAFETY: This controlled test fixture matches the asserted contract used by this test.
        settings: {
          update: async () => {
            markMutationStarted()
            await mutationMayFinish
            return { timeZone: "America/New_York", locale: "en", hourCycle: "h23" }
          }
        } as never
      },
      { uiBaseUrl: "https://bob.example.invalid", now: () => new Date(at) }
    )
    await expect(executor.mutationActivity(runId)).resolves.toEqual({ status: "none" })
    const argumentsValue = { timeZone: "America/New_York" }
    const mutation = executor.execute({
      runId,
      toolCallId: "activity-settings-call",
      idempotencyKey: await conversationMutationIdempotencyKey({
        ownerId,
        conversationTurnId: turnId,
        toolName: "settings_update",
        arguments: argumentsValue
      }),
      ownerId,
      name: "settings_update",
      arguments: argumentsValue
    })
    await mutationStarted
    await activateSecondConversationRun(seeded, userText, ["settings_update"])

    await expect(executor.mutationActivity(secondRunId)).resolves.toEqual({
      status: "active",
      retryAt: "2026-08-11T10:01:00.000Z",
      recoveryRequired: false,
      recoveryExhausted: false,
      originRevision: 1
    })
    releaseMutation()
    await expect(mutation).resolves.toMatchObject({ ok: true, code: "owner_settings_updated" })
    await expect(executor.mutationActivity(secondRunId)).resolves.toEqual({
      status: "completed",
      completedInRun: false
    })
  })

  it("gives an expired mutation a bounded recovery deadline", async () => {
    const seeded = await seedActiveConversationRun("Set my time zone to America/New_York.", [
      "settings_update"
    ])
    await seeded.database.insert(toolCalls).values({
      id: "00000000-0000-4000-8000-000000002090",
      runId,
      toolCallId: "expired-activity-settings-call",
      idempotencyKey: "sha256:expired-activity",
      ownerId,
      toolName: "settings_update",
      commandHash: "sha256:expired-command",
      argumentsJson: "{}",
      status: "executing",
      claimToken: "expired-token",
      claimedAt: "2026-08-11T09:58:59.000Z",
      claimExpiresAt: "2026-08-11T09:59:59.000Z",
      attemptNumber: 1,
      createdAt: "2026-08-11T09:58:59.000Z"
    })
    const executor = makeExecutor(seeded.database, seeded.protection, async () => [])

    await expect(executor.mutationActivity(runId)).resolves.toEqual({
      status: "active",
      retryAt: "2026-08-11T10:01:00.000Z",
      recoveryRequired: true,
      recoveryExhausted: false,
      originRevision: 1
    })
    await activateSecondConversationRun(seeded, "Set my time zone to America/New_York.", [
      "settings_update"
    ])
    await expect(executor.expireMutationRecovery(secondRunId)).resolves.toBe(true)
    await expect(executor.mutationActivity(secondRunId)).resolves.toEqual({ status: "unknown" })
    const [expired] = await seeded.database
      .select({ status: toolCalls.status, resultJson: toolCalls.resultJson })
      .from(toolCalls)
      .where(eq(toolCalls.id, "00000000-0000-4000-8000-000000002090"))
    expect(expired).toMatchObject({ status: "unknown" })
    expect(expired?.resultJson).not.toBeNull()
  })

  it("exhausts recovery after the stable mutation is reparented and expires again", async () => {
    const userText = "Set my time zone to America/New_York."
    const seeded = await seedActiveConversationRun(userText, ["settings_update"])
    const argumentsValue = { timeZone: "America/New_York" }
    const idempotencyKey = await conversationMutationIdempotencyKey({
      ownerId,
      conversationTurnId: turnId,
      toolName: "settings_update",
      arguments: argumentsValue
    })
    await seeded.database.insert(toolCalls).values({
      id: "00000000-0000-4000-8000-000000002091",
      runId,
      toolCallId: "first-expired-settings-call",
      idempotencyKey,
      ownerId,
      toolName: "settings_update",
      commandHash: "sha256:first-expired-command",
      argumentsJson: "{}",
      status: "executing",
      claimToken: "first-expired-token",
      claimedAt: "2026-08-11T09:58:59.000Z",
      claimExpiresAt: "2026-08-11T09:59:59.000Z",
      attemptNumber: 1,
      createdAt: "2026-08-11T09:58:59.000Z"
    })
    await activateSecondConversationRun(seeded, userText, ["settings_update"])
    let currentTime = new Date(at)
    let mutationStarted!: () => void
    const started = new Promise<void>((resolve) => {
      mutationStarted = resolve
    })
    let releaseMutation!: () => void
    const mayFinish = new Promise<void>((resolve) => {
      releaseMutation = resolve
    })
    const executor = makeTestToolExecutor(
      seeded.database,
      seeded.protection,
      {
        // SAFETY: This controlled test fixture matches the asserted contract used by this test.
        reminders: {} as never,
        // SAFETY: This controlled test fixture matches the asserted contract used by this test.
        memory: {} as never,
        // SAFETY: This controlled test fixture matches the asserted contract used by this test.
        journal: {} as never,
        // SAFETY: This controlled test fixture matches the asserted contract used by this test.
        training: {} as never,
        // SAFETY: This controlled test fixture matches the asserted contract used by this test.
        settings: {
          update: async () => {
            mutationStarted()
            await mayFinish
            return { timeZone: "America/New_York", locale: "en", hourCycle: "h23" }
          }
        } as never
      },
      { uiBaseUrl: "https://bob.example.invalid", now: () => currentTime }
    )

    const recovery = executor.execute({
      runId: secondRunId,
      toolCallId: "second-recovery-settings-call",
      idempotencyKey,
      ownerId,
      name: "settings_update",
      arguments: argumentsValue
    })
    await started
    currentTime = new Date("2026-08-11T10:01:01.000Z")

    await expect(executor.mutationActivity(secondRunId)).resolves.toMatchObject({
      status: "active",
      recoveryRequired: true,
      recoveryExhausted: true,
      originRevision: 2
    })
    await expect(executor.expireMutationRecovery(secondRunId)).resolves.toBe(true)
    await expect(executor.mutationActivity(secondRunId)).resolves.toEqual({ status: "unknown" })

    releaseMutation()
    await expect(recovery).resolves.toMatchObject({ ok: true, code: "owner_settings_updated" })
    await expect(executor.mutationActivity(secondRunId)).resolves.toEqual({ status: "unknown" })
  })

  it.each([
    { priorStatus: "pending" as const, claimExpiresAt: null },
    {
      priorStatus: "executing" as const,
      claimExpiresAt: "2026-08-11T09:59:59.000Z"
    }
  ])(
    "adopts a $priorStatus stable mutation from a superseded revision",
    async ({ priorStatus, claimExpiresAt }) => {
      const userText = "Set my time zone to America/New_York and use 24-hour time."
      const seeded = await seedActiveConversationRun(userText, ["settings_update"])
      const argumentsValue = { timeZone: "America/New_York", hourCycle: "h23" } as const
      const idempotencyKey = await conversationMutationIdempotencyKey({
        ownerId,
        conversationTurnId: turnId,
        toolName: "settings_update",
        arguments: argumentsValue
      })
      const firstCommand = {
        runId,
        toolCallId: `revision-one-${priorStatus}-settings-call`,
        idempotencyKey,
        ownerId,
        name: "settings_update" as const,
        arguments: argumentsValue
      }
      const encryptedArguments = await seeded.protection.encryptText(
        seeded.ownerKey,
        JSON.stringify(argumentsValue)
      )
      await seeded.database.insert(toolCalls).values({
        id: "00000000-0000-4000-8000-000000002015",
        runId,
        toolCallId: firstCommand.toolCallId,
        idempotencyKey,
        ownerId,
        toolName: firstCommand.name,
        commandHash: await toolCommandHash(firstCommand),
        argumentsJson: JSON.stringify(encryptedArguments),
        status: priorStatus,
        claimToken: priorStatus === "executing" ? "expired-claim" : null,
        claimedAt: priorStatus === "executing" ? "2026-08-11T09:58:00.000Z" : null,
        claimExpiresAt,
        attemptNumber: priorStatus === "executing" ? 1 : 0,
        createdAt: "2026-08-11T09:58:00.000Z"
      })
      await activateSecondConversationRun(seeded, userText, ["settings_update"])

      let updateCalls = 0
      const executor = makeTestToolExecutor(
        seeded.database,
        seeded.protection,
        {
          // SAFETY: This controlled test fixture matches the asserted contract used by this test.
          reminders: {} as never,
          // SAFETY: This controlled test fixture matches the asserted contract used by this test.
          memory: {} as never,
          // SAFETY: This controlled test fixture matches the asserted contract used by this test.
          journal: {} as never,
          // SAFETY: This controlled test fixture matches the asserted contract used by this test.
          training: {} as never,
          // SAFETY: This controlled test fixture matches the asserted contract used by this test.
          settings: {
            update: async () => {
              updateCalls += 1
              return {
                timeZone: "America/New_York",
                locale: "en",
                hourCycle: "h23"
              }
            }
          } as never
        },
        { uiBaseUrl: "https://bob.example.invalid", now: () => new Date(at) }
      )
      const result = await executor.execute({
        ...firstCommand,
        runId: secondRunId,
        toolCallId: `revision-two-${priorStatus}-settings-call`
      })

      expect(result).toMatchObject({ ok: true, code: "owner_settings_updated" })
      expect(updateCalls).toBe(1)
      const [adopted] = await seeded.database
        .select()
        .from(toolCalls)
        .where(eq(toolCalls.idempotencyKey, idempotencyKey))
      expect(adopted).toMatchObject({
        runId: secondRunId,
        status: "completed",
        attemptNumber: priorStatus === "executing" ? 2 : 1
      })
    }
  )

  it("replays a reminder mutation while validating the current source message", async () => {
    const userText = "Remind me tomorrow at 13:00."
    const seeded = await seedActiveConversationRun(userText, ["reminder_create"])
    const semanticArguments = {
      displayText: "Lunch",
      smsSafeText: "Lunch",
      localDate: "2026-08-12",
      localTime: "13:00",
      timeZone: "Europe/Stockholm",
      dueAt: "2026-08-12T11:00:00.000Z"
    } as const
    const firstArguments = { ...semanticArguments, sourceMessageId: messageId }
    const idempotencyKey = await conversationMutationIdempotencyKey({
      ownerId,
      conversationTurnId: turnId,
      toolName: "reminder_create",
      arguments: firstArguments
    })
    let createCalls = 0
    const executor = makeTestToolExecutor(
      seeded.database,
      seeded.protection,
      {
        // SAFETY: This controlled test fixture matches the asserted contract used by this test.
        reminders: {
          createOneShot: async () => {
            createCalls += 1
            return {
              reminderId: "00000000-0000-4000-8000-000000002012",
              occurrenceId: "00000000-0000-4000-8000-000000002013",
              localDisplayTime: "2026-08-12T13:00+02:00[Europe/Stockholm]",
              duplicate: false
            }
          }
        } as never,
        // SAFETY: This controlled test fixture matches the asserted contract used by this test.
        memory: {} as never,
        // SAFETY: This controlled test fixture matches the asserted contract used by this test.
        journal: {} as never,
        // SAFETY: This controlled test fixture matches the asserted contract used by this test.
        training: {} as never,
        // SAFETY: This controlled test fixture matches the asserted contract used by this test.
        settings: {} as never
      },
      { uiBaseUrl: "https://bob.example.invalid", now: () => new Date(at) }
    )
    const firstResult = await executor.execute({
      runId,
      toolCallId: "revision-one-reminder-call",
      idempotencyKey,
      ownerId,
      name: "reminder_create",
      arguments: firstArguments
    })
    expect(firstResult).toMatchObject({ ok: true, code: "reminder_created" })
    await activateSecondConversationRun(seeded, userText, ["reminder_create"])

    await expect(
      executor.execute({
        runId: secondRunId,
        toolCallId: "revision-two-wrong-source-call",
        idempotencyKey,
        ownerId,
        name: "reminder_create",
        arguments: firstArguments
      })
    ).resolves.toMatchObject({ ok: false, code: "policy_denied" })
    const replay = await executor.execute({
      runId: secondRunId,
      toolCallId: "revision-two-reminder-call",
      idempotencyKey,
      ownerId,
      name: "reminder_create",
      arguments: { ...semanticArguments, sourceMessageId: secondMessageId }
    })

    expect(replay).toEqual(firstResult)
    expect(createCalls).toBe(1)
  })

  it("reruns a read-only tool across conversation turn revisions", async () => {
    const seeded = await seedActiveConversationRun()
    let listCalls = 0
    const executor = makeExecutor(seeded.database, seeded.protection, async () => {
      listCalls += 1
      return []
    })

    await expect(executor.execute(listCommand("revision-one-read"))).resolves.toMatchObject({
      ok: true,
      code: "reminder_list"
    })
    await activateSecondConversationRun(seeded, "List reminders", ["reminder_list"])
    await expect(
      executor.execute({
        ...listCommand("revision-two-read"),
        runId: secondRunId
      })
    ).resolves.toMatchObject({ ok: true, code: "reminder_list" })

    expect(listCalls).toBe(2)
  })

  it("keeps read-only tools available after a latest-fragment retraction", async () => {
    const seeded = await seedActiveConversationRun(
      "Never mind.",
      ["reminder_list"],
      [
        {
          sourceMessageId: "00000000-0000-4000-8000-000000002014",
          text: "List my reminders."
        },
        { sourceMessageId: messageId, text: "Never mind." }
      ]
    )
    let listCalls = 0
    const executor = makeExecutor(seeded.database, seeded.protection, async () => {
      listCalls += 1
      return []
    })

    await expect(executor.execute(listCommand("read-after-retraction"))).resolves.toMatchObject({
      ok: true,
      code: "reminder_list"
    })
    expect(listCalls).toBe(1)
  })

  it("does not start a tool after its conversation revision is superseded", async () => {
    const { database, protection } = await seedActiveConversationRun()
    await database
      .update(conversationTurns)
      .set({ revision: 2, status: "collecting", updatedAt: "2026-08-11T10:00:01.000Z" })
      .where(eq(conversationTurns.id, turnId))
    let listCalls = 0
    const executor = makeExecutor(database, protection, async () => {
      listCalls += 1
      return []
    })

    const result = await executor.execute(listCommand("superseded-revision"))

    expect(result).toMatchObject({ ok: false, code: "policy_denied" })
    expect(listCalls).toBe(0)
  })

  it("does not start a tool after the conversation selects another active run", async () => {
    const { database, protection } = await seedActiveConversationRun()
    await database
      .update(conversationTurns)
      .set({
        activeRunId: "00000000-0000-4000-8000-000000002008",
        updatedAt: "2026-08-11T10:00:01.000Z"
      })
      .where(eq(conversationTurns.id, turnId))
    let listCalls = 0
    const executor = makeExecutor(database, protection, async () => {
      listCalls += 1
      return []
    })

    const result = await executor.execute(listCommand("inactive-run"))

    expect(result).toMatchObject({ ok: false, code: "policy_denied" })
    expect(listCalls).toBe(0)
  })

  it("lets a claimed tool finish after its conversation revision is superseded", async () => {
    const { database, protection } = await seedActiveConversationRun()
    let markStarted!: () => void
    let finishList!: (value: readonly never[]) => void
    const started = new Promise<void>((resolve) => {
      markStarted = resolve
    })
    const listResult = new Promise<readonly never[]>((resolve) => {
      finishList = resolve
    })
    const executor = makeExecutor(database, protection, async () => {
      markStarted()
      return listResult
    })
    const resultPromise = executor.execute(listCommand("claimed-before-superseded"))
    await started

    await database
      .update(conversationTurns)
      .set({ revision: 2, status: "collecting", updatedAt: "2026-08-11T10:00:01.000Z" })
      .where(eq(conversationTurns.id, turnId))
    finishList([])

    await expect(resultPromise).resolves.toMatchObject({ ok: true, code: "reminder_list" })
  })
})
