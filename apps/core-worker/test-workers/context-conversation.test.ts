import { applyD1Migrations, reset } from "cloudflare:test"
import { env } from "cloudflare:workers"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { createCoreDatabase } from "../src/database.ts"
import { makeContextStore } from "../src/modules/context/store.ts"
import {
  agentRuns,
  conversationTurnMessages,
  conversationTurns,
  messages,
  toolCalls,
  users
} from "../src/modules/conversations/schema.ts"
import { deliveryAttempts, outboxMessages } from "../src/modules/delivery/schema.ts"
import { factRevisions, facts } from "../src/modules/memory/schema.ts"
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

const ownerId = "00000000-0000-4000-8000-000000000601"
const channelId = "00000000-0000-4000-8000-000000000602"
const currentTurnId = "00000000-0000-4000-8000-000000000603"

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

function uuid(value: number): string {
  return `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`
}

async function seedOwner() {
  const database = createCoreDatabase(env.DB)
  const protection = createDataProtection({ 1: key(61) }, 1, key(62))
  const wrapped = await protection.createWrappedDataKey()
  const createdAt = "2026-08-12T10:00:00.000Z"
  await database.insert(users).values({
    id: ownerId,
    timeZone: "Europe/Stockholm",
    wrappedDataKey: wrapped.wrapped.ciphertext,
    wrappedDataKeyIv: wrapped.wrapped.iv,
    dataKeyVersion: wrapped.wrapped.version,
    createdAt,
    updatedAt: createdAt
  })
  return { database, protection, ownerKey: wrapped.key }
}

async function seedPriorTurn(
  fixture: Awaited<ReturnType<typeof seedOwner>>,
  input: {
    readonly sequence: number
    readonly inboundTexts: readonly string[]
    readonly outboundText: string
    readonly inboundAt: string
    readonly deliveredAt: string
    readonly channelId?: string
    readonly attemptState?: "accepted" | "delivered" | "failed"
    readonly outboxState?: "pending" | "accepted" | "failed"
    readonly turnStatus?: "collecting" | "committing" | "replied"
  }
) {
  const turnId = uuid(input.sequence)
  const outboxId = uuid(input.sequence + 1)
  const outboundId = uuid(input.sequence + 2)
  const actualChannelId = input.channelId ?? channelId
  const inboundRecords = await Promise.all(
    input.inboundTexts.map(async (text, index) => {
      const messageId = uuid(input.sequence + 10 + index)
      const eventId = uuid(input.sequence + 20 + index)
      return {
        messageId,
        eventId,
        encrypted: await fixture.protection.encryptText(fixture.ownerKey, text),
        ordinal: index + 1
      }
    })
  )
  const outbound = await fixture.protection.encryptText(fixture.ownerKey, input.outboundText)
  await fixture.database.insert(messages).values([
    ...inboundRecords.map((record) => ({
      id: record.messageId,
      userId: ownerId,
      channelId: actualChannelId,
      direction: "inbound" as const,
      textCiphertext: record.encrypted.ciphertext,
      textIv: record.encrypted.iv,
      dataKeyVersion: 1,
      occurredAt: input.inboundAt,
      createdAt: input.inboundAt
    })),
    {
      id: outboundId,
      userId: ownerId,
      channelId: actualChannelId,
      direction: "outbound" as const,
      textCiphertext: outbound.ciphertext,
      textIv: outbound.iv,
      dataKeyVersion: 1,
      occurredAt: input.deliveredAt,
      createdAt: input.deliveredAt
    }
  ])
  const latest = inboundRecords.at(-1)!
  await fixture.database.insert(conversationTurns).values({
    id: turnId,
    userId: ownerId,
    channelId: actualChannelId,
    status: input.turnStatus ?? "replied",
    revision: inboundRecords.length,
    latestInboundEventId: latest.eventId,
    latestMessageId: latest.messageId,
    quietUntil: input.inboundAt,
    burstExpiresAt: input.inboundAt,
    replyOutboxId: outboxId,
    createdAt: input.inboundAt,
    updatedAt: input.deliveredAt,
    repliedAt:
      input.turnStatus === "replied" || input.turnStatus === undefined ? input.deliveredAt : null
  })
  await fixture.database.insert(conversationTurnMessages).values(
    inboundRecords.map((record) => ({
      turnId,
      inboundEventId: record.eventId,
      messageId: record.messageId,
      ordinal: record.ordinal,
      revision: record.ordinal,
      createdAt: input.inboundAt
    }))
  )
  await fixture.database.insert(outboxMessages).values({
    id: outboxId,
    userId: ownerId,
    channelId: actualChannelId,
    messageId: outboundId,
    reasonCode: "agent_reply",
    correlationId: latest.eventId,
    idempotencyKey: `turn-${input.sequence}-reply`,
    conversationTurnId: turnId,
    conversationTurnRevision: inboundRecords.length,
    state: input.outboxState ?? "accepted",
    completedAt: input.deliveredAt,
    createdAt: input.deliveredAt
  })
  if (input.attemptState !== undefined) {
    await fixture.database.insert(deliveryAttempts).values({
      id: uuid(input.sequence + 3),
      outboxId,
      attemptNumber: 1,
      state: input.attemptState,
      providerMessageHandle: `provider-${input.sequence}`,
      startedAt: input.deliveredAt,
      updatedAt: input.deliveredAt
    })
  }
  return {
    turnId,
    outboxId,
    outboundId,
    inboundIds: inboundRecords.map((record) => record.messageId)
  }
}

describe("recent conversation context", () => {
  it("does not inherit a capability across a newer unrelated delivered turn", async () => {
    const fixture = await seedOwner()
    const reminderTurn = await seedPriorTurn(fixture, {
      sequence: 500,
      inboundTexts: ["List my reminders"],
      outboundText: "You have no active reminders.",
      inboundAt: "2026-08-12T10:02:00.000Z",
      deliveredAt: "2026-08-12T10:03:00.000Z",
      attemptState: "delivered"
    })
    await seedPriorTurn(fixture, {
      sequence: 530,
      inboundTexts: ["Thanks"],
      outboundText: "You are welcome.",
      inboundAt: "2026-08-12T10:04:00.000Z",
      deliveredAt: "2026-08-12T10:05:00.000Z",
      attemptState: "delivered"
    })
    const runId = uuid(560)
    await fixture.database.insert(agentRuns).values({
      id: runId,
      userId: ownerId,
      inboundEventId: uuid(561),
      conversationTurnId: reminderTurn.turnId,
      conversationTurnRevision: 1,
      targetMessageId: reminderTurn.inboundIds[0],
      correlationId: uuid(562),
      inputSnapshotJson: "{}",
      inputHash: "sha256:reminder-list",
      status: "completed",
      model: "gpt-test",
      completedAt: "2026-08-12T10:02:50.000Z",
      createdAt: "2026-08-12T10:02:10.000Z"
    })
    await fixture.database.insert(toolCalls).values({
      id: uuid(563),
      runId,
      toolCallId: "reminder-list-call",
      idempotencyKey: "reminder-list-key",
      ownerId,
      toolName: "reminder_list",
      argumentsJson: "{}",
      status: "completed",
      createdAt: "2026-08-12T10:02:20.000Z",
      completedAt: "2026-08-12T10:02:30.000Z"
    })

    const context = makeContextStore(fixture.database, fixture.protection, {})

    await expect(
      context.recentToolCapabilities({
        ownerId,
        channelId,
        currentConversationTurnId: currentTurnId,
        currentMessageId: uuid(564),
        currentUserText: "List",
        localTime: "2026-08-12T10:10:00.000Z",
        timeZone: "Europe/Stockholm"
      })
    ).resolves.toEqual([])
  })

  it("returns only safe read capabilities from a delivered prior turn", async () => {
    const fixture = await seedOwner()
    const prior = await seedPriorTurn(fixture, {
      sequence: 580,
      inboundTexts: ["PRIVATE_PRIOR_OWNER_TEXT"],
      outboundText: "PRIVATE_PRIOR_BOB_TEXT",
      inboundAt: "2026-08-12T10:04:00.000Z",
      deliveredAt: "2026-08-12T10:05:00.000Z",
      attemptState: "delivered"
    })
    const runId = uuid(584)
    await fixture.database.insert(agentRuns).values({
      id: runId,
      userId: ownerId,
      inboundEventId: uuid(585),
      conversationTurnId: prior.turnId,
      conversationTurnRevision: 1,
      targetMessageId: prior.inboundIds[0],
      correlationId: uuid(586),
      inputSnapshotJson: "PRIVATE_INPUT_SNAPSHOT",
      inputHash: "sha256:private-input",
      status: "completed",
      model: "gpt-test",
      completedAt: "2026-08-12T10:04:50.000Z",
      createdAt: "2026-08-12T10:04:10.000Z"
    })
    await fixture.database.insert(toolCalls).values([
      {
        id: uuid(587),
        runId,
        toolCallId: "private-reminder-list-call",
        idempotencyKey: "private-reminder-list-key",
        ownerId,
        toolName: "reminder_list",
        argumentsJson: "PRIVATE_REMINDER_LIST_ARGUMENTS",
        status: "completed",
        createdAt: "2026-08-12T10:04:20.000Z",
        completedAt: "2026-08-12T10:04:30.000Z"
      },
      {
        id: uuid(588),
        runId,
        toolCallId: "private-reminder-create-call",
        idempotencyKey: "private-reminder-create-key",
        ownerId,
        toolName: "reminder_create",
        argumentsJson: "PRIVATE_REMINDER_CREATE_ARGUMENTS",
        status: "completed",
        createdAt: "2026-08-12T10:04:21.000Z",
        completedAt: "2026-08-12T10:04:31.000Z"
      },
      {
        id: uuid(589),
        runId,
        toolCallId: "private-journal-call",
        idempotencyKey: "private-journal-key",
        ownerId,
        toolName: "journal_search_metadata",
        argumentsJson: "PRIVATE_JOURNAL_ARGUMENTS",
        status: "completed",
        createdAt: "2026-08-12T10:04:22.000Z",
        completedAt: "2026-08-12T10:04:32.000Z"
      }
    ])

    const context = makeContextStore(fixture.database, fixture.protection, {})
    const capabilityRequest = {
      ownerId,
      channelId,
      currentConversationTurnId: currentTurnId,
      currentMessageId: uuid(590),
      currentUserText: "List",
      localTime: "2026-08-12T10:10:00.000Z",
      timeZone: "Europe/Stockholm"
    }
    const capabilities = await context.recentToolCapabilities(capabilityRequest)

    expect(capabilities).toEqual(["reminder_list"])
    expect(JSON.stringify(capabilities)).not.toMatch(/PRIVATE_|journal|create/u)
  })

  it("adds one delivered prior turn as untrusted same-channel context", async () => {
    const fixture = await seedOwner()
    const inboundAt = "2026-08-12T10:04:00.000Z"
    const deliveredAt = "2026-08-12T10:05:00.000Z"
    const prior = await seedPriorTurn(fixture, {
      sequence: 620,
      inboundTexts: ["Lost my reminders"],
      outboundText: "You have no active reminders.",
      inboundAt,
      deliveredAt,
      attemptState: "delivered"
    })

    const context = makeContextStore(fixture.database, fixture.protection, {})
    const items = await context.build({
      ownerId,
      channelId,
      currentConversationTurnId: currentTurnId,
      currentMessageId: "00000000-0000-4000-8000-000000000610",
      currentUserText: "List",
      localTime: "2026-08-12T10:10:00.000Z",
      timeZone: "Europe/Stockholm"
    })

    expect(items).toEqual([
      {
        kind: "conversation",
        text: "Owner: Lost my reminders\nBob: You have no active reminders.",
        instruction: false,
        conflict: false,
        sources: [
          {
            sourceId: prior.inboundIds[0],
            sourceLabel: "owner message 2026-08-12",
            occurredAt: inboundAt
          },
          {
            sourceId: prior.outboundId,
            sourceLabel: "Bob reply 2026-08-12",
            occurredAt: deliveredAt
          }
        ]
      }
    ])
  })

  it("uses only delivered prior turns from the same channel and fifteen-minute window", async () => {
    const fixture = await seedOwner()
    const eligible = await seedPriorTurn(fixture, {
      sequence: 650,
      inboundTexts: ["Eligible owner message"],
      outboundText: "Eligible Bob reply",
      inboundAt: "2026-08-12T10:08:00.000Z",
      deliveredAt: "2026-08-12T10:09:00.000Z",
      attemptState: "delivered"
    })
    const current = await seedPriorTurn(fixture, {
      sequence: 680,
      inboundTexts: ["Current turn must not be recalled"],
      outboundText: "Current reply must not be recalled",
      inboundAt: "2026-08-12T10:08:30.000Z",
      deliveredAt: "2026-08-12T10:09:30.000Z",
      attemptState: "delivered"
    })
    await seedPriorTurn(fixture, {
      sequence: 710,
      inboundTexts: ["Wrong channel"],
      outboundText: "Wrong channel reply",
      inboundAt: "2026-08-12T10:08:00.000Z",
      deliveredAt: "2026-08-12T10:09:00.000Z",
      channelId: uuid(799),
      attemptState: "delivered"
    })
    await seedPriorTurn(fixture, {
      sequence: 740,
      inboundTexts: ["Too old"],
      outboundText: "Too old reply",
      inboundAt: "2026-08-12T09:53:00.000Z",
      deliveredAt: "2026-08-12T09:54:00.000Z",
      attemptState: "delivered"
    })
    await seedPriorTurn(fixture, {
      sequence: 770,
      inboundTexts: ["Only accepted"],
      outboundText: "Accepted reply",
      inboundAt: "2026-08-12T10:07:00.000Z",
      deliveredAt: "2026-08-12T10:08:00.000Z",
      attemptState: "accepted"
    })
    await seedPriorTurn(fixture, {
      sequence: 800,
      inboundTexts: ["Failed delivery"],
      outboundText: "Failed reply",
      inboundAt: "2026-08-12T10:06:00.000Z",
      deliveredAt: "2026-08-12T10:07:00.000Z",
      attemptState: "failed",
      outboxState: "failed"
    })
    await seedPriorTurn(fixture, {
      sequence: 830,
      inboundTexts: ["Draft reply"],
      outboundText: "Unsent draft",
      inboundAt: "2026-08-12T10:05:00.000Z",
      deliveredAt: "2026-08-12T10:06:00.000Z",
      turnStatus: "committing",
      outboxState: "pending"
    })

    const context = makeContextStore(fixture.database, fixture.protection, {})
    const items = await context.build({
      ownerId,
      channelId,
      currentConversationTurnId: current.turnId,
      currentMessageId: uuid(860),
      currentUserText: "Continue",
      localTime: "2026-08-12T10:10:00.000Z",
      timeZone: "Europe/Stockholm"
    })

    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({
      kind: "conversation",
      text: "Owner: Eligible owner message\nBob: Eligible Bob reply",
      sources: [{ sourceId: eligible.inboundIds[0] }, { sourceId: eligible.outboundId }]
    })
  })

  it("excludes an entire prior turn when its messages show journal intent", async () => {
    const fixture = await seedOwner()
    await seedPriorTurn(fixture, {
      sequence: 870,
      inboundTexts: ["Journal: I felt afraid today"],
      outboundText: "Open your private journal link.",
      inboundAt: "2026-08-12T10:07:00.000Z",
      deliveredAt: "2026-08-12T10:08:00.000Z",
      attemptState: "delivered"
    })
    await seedPriorTurn(fixture, {
      sequence: 900,
      inboundTexts: ["List my reminders"],
      outboundText: "You have no active reminders.",
      inboundAt: "2026-08-12T10:05:00.000Z",
      deliveredAt: "2026-08-12T10:06:00.000Z",
      attemptState: "delivered"
    })

    const context = makeContextStore(fixture.database, fixture.protection, {})
    const items = await context.build({
      ownerId,
      channelId,
      currentConversationTurnId: currentTurnId,
      currentMessageId: uuid(930),
      currentUserText: "Continue",
      localTime: "2026-08-12T10:10:00.000Z",
      timeZone: "Europe/Stockholm"
    })

    expect(items).toHaveLength(1)
    expect(items[0]?.text).toBe("Owner: List my reminders\nBob: You have no active reminders.")
    expect(JSON.stringify(items)).not.toContain("afraid")
    expect(JSON.stringify(items)).not.toContain("journal")
  })

  it("keeps at most six messages from the most recent delivered turns", async () => {
    const fixture = await seedOwner()
    for (const [index, minute] of [4, 6, 8, 9].entries()) {
      await seedPriorTurn(fixture, {
        sequence: 950 + index * 30,
        inboundTexts: [`Owner turn ${index + 1}`],
        outboundText: `Bob turn ${index + 1}`,
        inboundAt: `2026-08-12T10:0${minute - 1}:00.000Z`,
        deliveredAt: `2026-08-12T10:0${minute}:00.000Z`,
        attemptState: "delivered"
      })
    }

    const context = makeContextStore(fixture.database, fixture.protection, {})
    const items = await context.build({
      ownerId,
      channelId,
      currentConversationTurnId: currentTurnId,
      currentMessageId: uuid(1080),
      currentUserText: "Continue",
      localTime: "2026-08-12T10:10:00.000Z",
      timeZone: "Europe/Stockholm"
    })

    expect(items).toHaveLength(3)
    expect(items.flatMap((item) => item.sources)).toHaveLength(6)
    expect(items.map((item) => item.text)).toEqual([
      "Owner: Owner turn 2\nBob: Bob turn 2",
      "Owner: Owner turn 3\nBob: Bob turn 3",
      "Owner: Owner turn 4\nBob: Bob turn 4"
    ])
  })

  it("bounds recent conversation text to 2400 characters", async () => {
    const fixture = await seedOwner()
    for (const [index, minute] of [5, 7, 9].entries()) {
      await seedPriorTurn(fixture, {
        sequence: 1100 + index * 30,
        inboundTexts: [`owner-${index + 1}-` + "a".repeat(500)],
        outboundText: `${index === 2 ? "latest-marker" : `bob-${index + 1}`}-` + "b".repeat(500),
        inboundAt: `2026-08-12T10:0${minute - 1}:00.000Z`,
        deliveredAt: `2026-08-12T10:0${minute}:00.000Z`,
        attemptState: "delivered"
      })
    }

    const context = makeContextStore(fixture.database, fixture.protection, {})
    const items = await context.build({
      ownerId,
      channelId,
      currentConversationTurnId: currentTurnId,
      currentMessageId: uuid(1200),
      currentUserText: "Continue",
      localTime: "2026-08-12T10:10:00.000Z",
      timeZone: "Europe/Stockholm"
    })

    expect(items.reduce((total, item) => total + item.text.length, 0)).toBeLessThanOrEqual(2_400)
    expect(items.some((item) => item.text.includes("latest-marker"))).toBe(true)
  })

  it("preserves legacy context behavior when no current turn is supplied", async () => {
    const fixture = await seedOwner()
    await seedPriorTurn(fixture, {
      sequence: 1230,
      inboundTexts: ["Prior owner message"],
      outboundText: "Prior Bob reply",
      inboundAt: "2026-08-12T10:08:00.000Z",
      deliveredAt: "2026-08-12T10:09:00.000Z",
      attemptState: "delivered"
    })

    const context = makeContextStore(fixture.database, fixture.protection, {})

    await expect(
      context.build({
        ownerId,
        channelId,
        currentMessageId: uuid(1260),
        currentUserText: "Continue",
        localTime: "2026-08-12T10:10:00.000Z",
        timeZone: "Europe/Stockholm"
      })
    ).resolves.toEqual([])
  })

  it("carries a completed prior-revision tool receipt without its arguments", async () => {
    const fixture = await seedOwner()
    const result = {
      ok: true,
      code: "reminder_created",
      message: "The reminder was created.",
      data: { reminderId: uuid(1110) }
    }
    const encryptedResult = await fixture.protection.encryptText(
      fixture.ownerKey,
      JSON.stringify(result)
    )
    await fixture.database.insert(agentRuns).values({
      id: uuid(1111),
      userId: ownerId,
      inboundEventId: uuid(1112),
      conversationTurnId: currentTurnId,
      conversationTurnRevision: 1,
      targetMessageId: uuid(1113),
      correlationId: uuid(1114),
      inputSnapshotJson: "{}",
      inputHash: "sha256:test",
      status: "superseded",
      model: "gpt-test",
      completedAt: "2026-08-12T10:09:00.000Z",
      createdAt: "2026-08-12T10:08:00.000Z"
    })
    await fixture.database.insert(toolCalls).values({
      id: uuid(1115),
      runId: uuid(1111),
      toolCallId: "provider-call-private",
      idempotencyKey: "private-idempotency-key",
      ownerId,
      toolName: "reminder_create",
      commandHash: "sha256:private-command",
      argumentsJson: "PRIVATE_ARGUMENT_CANARY",
      resultJson: JSON.stringify(encryptedResult),
      status: "completed",
      createdAt: "2026-08-12T10:08:30.000Z",
      completedAt: "2026-08-12T10:09:00.000Z"
    })

    const context = makeContextStore(fixture.database, fixture.protection, {})
    const items = await context.build({
      ownerId,
      channelId,
      currentConversationTurnId: currentTurnId,
      currentConversationTurnRevision: 2,
      currentMessageId: uuid(1116),
      currentUserText: "Actually make it eight.",
      localTime: "2026-08-12T10:10:00.000Z",
      timeZone: "Europe/Stockholm"
    })

    expect(items).toEqual([
      {
        kind: "conversation",
        text: `Earlier revision tool receipt. Do not repeat an identical completed mutation. ${JSON.stringify(
          { toolName: "reminder_create", readOnly: false, result }
        )}`,
        instruction: false,
        conflict: false,
        sources: [
          {
            sourceId: uuid(1115),
            sourceLabel: "reminder_create receipt 2026-08-12",
            occurredAt: "2026-08-12T10:09:00.000Z"
          }
        ]
      }
    ])
    expect(JSON.stringify(items)).not.toContain("PRIVATE_ARGUMENT_CANARY")
    expect(JSON.stringify(items)).not.toContain("private-idempotency-key")
    expect(JSON.stringify(items)).not.toContain("provider-call-private")
  })

  it("keeps the newest terminal receipts when profile and conversation context fill the budget", async () => {
    const fixture = await seedOwner()
    const profileAt = "2026-08-12T09:50:00.000Z"
    for (let index = 0; index < 3; index += 1) {
      const factId = uuid(2_000 + index * 2)
      const revisionId = uuid(2_001 + index * 2)
      const text = `profile-${index}-`.padEnd(1_200, "p")
      const encrypted = await fixture.protection.encryptText(fixture.ownerKey, text)
      await fixture.database.batch([
        fixture.database.insert(facts).values({
          id: factId,
          userId: ownerId,
          scope: "personal",
          key: `profile-${index}`,
          currentRevisionId: revisionId,
          createdAt: profileAt
        }),
        fixture.database.insert(factRevisions).values({
          id: revisionId,
          factId,
          valueJson: JSON.stringify(text),
          canonicalTextCiphertext: encrypted.ciphertext,
          canonicalTextIv: encrypted.iv,
          dataKeyVersion: 1,
          assertionKind: "user_stated",
          originClass: "owner_input",
          observedAt: profileAt,
          extractionConfidence: 1_000,
          importance: 1_000,
          verificationStatus: "confirmed",
          sensitivity: "normal",
          modelEligible: true,
          channelEligible: true,
          createdAt: profileAt
        })
      ])
    }
    for (const [index, minute] of [6, 8].entries()) {
      await seedPriorTurn(fixture, {
        sequence: 2_100 + index * 30,
        inboundTexts: [`conversation-${index}-`.padEnd(700, "o")],
        outboundText: `reply-${index}-`.padEnd(700, "b"),
        inboundAt: `2026-08-12T10:0${minute - 1}:00.000Z`,
        deliveredAt: `2026-08-12T10:0${minute}:00.000Z`,
        attemptState: "delivered"
      })
    }
    for (let index = 0; index < 6; index += 1) {
      const result = {
        ok: true,
        code: "reminder_created",
        message:
          `${index === 0 ? "OLDEST_RECEIPT" : index === 5 ? "NEWEST_RECEIPT" : `receipt-${index}`}-`.padEnd(
            1_200,
            "r"
          )
      }
      const encryptedResult = await fixture.protection.encryptText(
        fixture.ownerKey,
        JSON.stringify(result)
      )
      const completedAt = `2026-08-12T10:09:0${index}.000Z`
      await fixture.database.batch([
        fixture.database.insert(agentRuns).values({
          id: uuid(2_200 + index * 2),
          userId: ownerId,
          inboundEventId: uuid(2_300 + index),
          conversationTurnId: currentTurnId,
          conversationTurnRevision: index + 1,
          targetMessageId: uuid(2_400 + index),
          correlationId: uuid(2_500 + index),
          inputSnapshotJson: "{}",
          inputHash: `sha256:receipt-${index}`,
          status: "superseded",
          model: "gpt-test",
          completedAt,
          createdAt: completedAt
        }),
        fixture.database.insert(toolCalls).values({
          id: uuid(2_201 + index * 2),
          runId: uuid(2_200 + index * 2),
          toolCallId: `private-call-${index}`,
          idempotencyKey: `private-key-${index}`,
          ownerId,
          toolName: "reminder_create",
          commandHash: `sha256:private-command-${index}`,
          argumentsJson: `PRIVATE_ARGUMENT_${index}`,
          resultJson: JSON.stringify(encryptedResult),
          status: "completed",
          createdAt: completedAt,
          completedAt
        })
      ])
    }

    const context = makeContextStore(fixture.database, fixture.protection, {})
    const items = await context.build({
      ownerId,
      channelId,
      currentConversationTurnId: currentTurnId,
      currentConversationTurnRevision: 7,
      currentMessageId: uuid(2_600),
      currentUserText: "Actually make it eight.",
      localTime: "2026-08-12T10:10:00.000Z",
      timeZone: "Europe/Stockholm"
    })
    const serialized = JSON.stringify(items)

    expect(items.reduce((total, item) => total + item.text.length, 0)).toBeLessThanOrEqual(6_000)
    expect(items.every((item) => item.text.length <= 1_200)).toBe(true)
    expect(serialized).toContain("NEWEST_RECEIPT")
    expect(serialized).not.toContain("OLDEST_RECEIPT")
    expect(serialized).not.toContain("PRIVATE_ARGUMENT_")
    expect(serialized).not.toContain("private-key-")
    expect(serialized).not.toContain("private-call-")
  })
})
