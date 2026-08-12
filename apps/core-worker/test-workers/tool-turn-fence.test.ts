import type { CurrentTurnMessage } from "@bob/contracts/agent"

import { conversationMutationIdempotencyKey, type ToolName } from "@bob/contracts/tools"
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
import { makeToolExecutor, toolCommandHash } from "../src/modules/conversations/tool-executor.ts"
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
  return makeToolExecutor(
    database,
    protection,
    {
      reminders: { list } as never,
      memory: {} as never,
      journal: {} as never,
      training: {} as never,
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
    sourceMessageId,
    requiresAcknowledgment: true
  } as const
}

beforeEach(async () => {
  await applyD1Migrations(env.DB, decodeTestMigrations(env.TEST_MIGRATIONS))
})

afterEach(async () => {
  await reset()
})

describe("conversation tool claim fence", () => {
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
    const executor = makeToolExecutor(
      seeded.database,
      seeded.protection,
      {
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
        memory: {} as never,
        journal: {} as never,
        training: {} as never,
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
      const executor = makeToolExecutor(
        seeded.database,
        seeded.protection,
        {
          reminders: {
            createOneShot: async () => {
              createCalls += 1
              return {} as never
            }
          } as never,
          memory: {} as never,
          journal: {} as never,
          training: {} as never,
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

  it.each(["Wait, what will that change?", "What will that change?"])(
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
      const executor = makeToolExecutor(
        seeded.database,
        seeded.protection,
        {
          reminders: {
            createOneShot: async () => {
              createCalls += 1
              return {} as never
            }
          } as never,
          memory: {} as never,
          journal: {} as never,
          training: {} as never,
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
    const executor = makeToolExecutor(
      database,
      protection,
      {
        reminders: {} as never,
        memory: {} as never,
        journal: {} as never,
        training: {} as never,
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
      const executor = makeToolExecutor(
        seeded.database,
        seeded.protection,
        {
          reminders: {} as never,
          memory: {} as never,
          journal: {} as never,
          training: {} as never,
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
      dueAt: "2026-08-12T11:00:00.000Z",
      requiresAcknowledgment: true
    } as const
    const firstArguments = { ...semanticArguments, sourceMessageId: messageId }
    const idempotencyKey = await conversationMutationIdempotencyKey({
      ownerId,
      conversationTurnId: turnId,
      toolName: "reminder_create",
      arguments: firstArguments
    })
    let createCalls = 0
    const executor = makeToolExecutor(
      seeded.database,
      seeded.protection,
      {
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
        memory: {} as never,
        journal: {} as never,
        training: {} as never,
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
