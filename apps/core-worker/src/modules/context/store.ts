import { PriorToolReceipt, type ContextItem } from "@bob/contracts/agent"
import { ToolName, ToolResult } from "@bob/contracts/tools"
import {
  and,
  asc,
  desc,
  eq,
  gte,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  ne,
  or,
  sql
} from "drizzle-orm"
import { Context, Layer, Schema } from "effect"

import type { CoreDatabase } from "../../database.ts"
import type { DataProtection } from "../policy/data-protection.ts"

import { artifactRevisions, artifacts } from "../artifacts/schema.ts"
import {
  agentRuns,
  conversationTurnMessages,
  conversationTurns,
  inboundEvents,
  messages,
  toolCalls,
  users
} from "../conversations/schema.ts"
import { deliveryAttempts, outboxMessages } from "../delivery/schema.ts"
import { buildFtsQuery } from "../memory/retrieval.ts"
import { factEvidence, factRevisions, facts } from "../memory/schema.ts"

export interface ContextBuildRequest {
  readonly ownerId: string
  readonly channelId: string
  readonly currentMessageId: string
  readonly currentConversationTurnId?: string
  readonly currentConversationTurnRevision?: number
  readonly currentUserText: string
  readonly localTime: string
  readonly timeZone: string
}

export interface ContextStore {
  /** String arguments remain valid for storage-safety tests and old snapshots. */
  build(input: ContextBuildRequest | string, channelId?: string): Promise<readonly ContextItem[]>
  priorToolReceipts(input: ContextBuildRequest): Promise<readonly PriorToolReceipt[]>
}

export const ContextStore = Context.Service<ContextStore>("bob/ContextStore")

export function boundContextItems(
  items: readonly ContextItem[],
  totalCharacterBudget: number,
  itemCharacterBudget: number
): readonly ContextItem[] {
  const bounded: ContextItem[] = []
  let remaining = totalCharacterBudget
  for (const item of items) {
    if (remaining <= 0) break
    const limit = Math.min(itemCharacterBudget, remaining)
    if (limit <= 0) break
    const text = item.text.slice(0, limit)
    if (text.length === 0) continue
    bounded.push({ ...item, text })
    remaining -= text.length
  }
  return Object.freeze(bounded)
}

/**
 * Turn untrusted text into a literal FTS5 OR query.
 *
 * FTS5 operators from the user never reach MATCH. Repeated and very short
 * tokens do not consume the query budget.
 */
export { buildFtsQuery } from "../memory/retrieval.ts"

function hasJournalIntent(text: string): boolean {
  return /\b(?:journal(?:ing)?|diar(?:y|ies)|dagbok(?:en|ar|arna)?|dagboks)\b|\/journal\//iu.test(
    text
  )
}

function contextKind(sourceType: string): ContextItem["kind"] {
  if (sourceType === "reminder") return "reminder"
  if (sourceType === "routine" || sourceType === "workout_session") return "training"
  return "fact"
}

function sourceDay(value: string | null | undefined): string {
  return value?.slice(0, 10) ?? "date unknown"
}

export function makeContextStore(
  database: CoreDatabase,
  protection: DataProtection,
  options: {
    readonly profileCharacterBudget?: number
    readonly retrievalCharacterBudget?: number
    readonly totalCharacterBudget?: number
    readonly itemCharacterBudget?: number
    readonly retrievalLimit?: number
  }
): ContextStore {
  const profileCharacterBudget = options.profileCharacterBudget ?? 3_600
  const retrievalCharacterBudget = options.retrievalCharacterBudget ?? 2_400
  const totalCharacterBudget = options.totalCharacterBudget ?? 6_000
  const itemCharacterBudget = options.itemCharacterBudget ?? 1_200
  const retrievalLimit = options.retrievalLimit ?? 8

  async function ownerKey(ownerId: string): Promise<CryptoKey> {
    const [owner] = await database.select().from(users).where(eq(users.id, ownerId)).limit(1)
    if (
      owner?.wrappedDataKey === null ||
      owner?.wrappedDataKey === undefined ||
      owner.wrappedDataKeyIv === null ||
      owner.wrappedDataKeyIv === undefined ||
      owner.dataKeyVersion === null ||
      owner.dataKeyVersion === undefined
    ) {
      throw new Error("Owner data key is unavailable")
    }
    return protection.unwrapDataKey({
      ciphertext: owner.wrappedDataKey,
      iv: owner.wrappedDataKeyIv,
      version: owner.dataKeyVersion
    })
  }

  async function profileContext(ownerId: string, key: CryptoKey): Promise<ContextItem[]> {
    const rows = await database
      .select({
        revision: factRevisions,
        sourceType: factEvidence.sourceType,
        sourceId: factEvidence.sourceId
      })
      .from(facts)
      .innerJoin(factRevisions, eq(facts.currentRevisionId, factRevisions.id))
      .leftJoin(
        factEvidence,
        and(
          eq(factEvidence.revisionId, factRevisions.id),
          eq(factEvidence.evidenceRole, "supports")
        )
      )
      .where(
        and(
          eq(facts.userId, ownerId),
          eq(factRevisions.verificationStatus, "confirmed"),
          eq(factRevisions.modelEligible, true),
          eq(factRevisions.channelEligible, true),
          isNull(factRevisions.validTo)
        )
      )
      .orderBy(desc(factRevisions.importance), asc(factRevisions.createdAt))

    const items: ContextItem[] = []
    const seen = new Set<string>()
    let usedCharacters = 0
    for (const row of rows) {
      if (seen.has(row.revision.id)) continue
      seen.add(row.revision.id)
      const text = await protection.decryptText(key, {
        ciphertext: row.revision.canonicalTextCiphertext,
        iv: row.revision.canonicalTextIv
      })
      if (usedCharacters + text.length > profileCharacterBudget) continue
      usedCharacters += text.length
      items.push({
        kind: "profile",
        text,
        instruction: false,
        conflict: false,
        sources: [
          {
            sourceId: row.sourceId ?? row.revision.id,
            sourceLabel: `${row.sourceType ?? "fact"} ${sourceDay(row.revision.observedAt)}`,
            occurredAt: row.revision.observedAt
          }
        ]
      })
    }
    return items
  }

  async function conversationContext(
    input: ContextBuildRequest,
    key: CryptoKey
  ): Promise<ContextItem[]> {
    if (input.currentConversationTurnId === undefined) return []
    const deliveredAfter = new Date(Date.parse(input.localTime) - 15 * 60_000).toISOString()
    const priorTurns = await database
      .select({
        id: conversationTurns.id,
        revision: conversationTurns.revision,
        outboundMessageId: outboxMessages.messageId,
        deliveredAt: deliveryAttempts.updatedAt
      })
      .from(conversationTurns)
      .innerJoin(
        outboxMessages,
        and(
          eq(outboxMessages.id, conversationTurns.replyOutboxId),
          eq(outboxMessages.conversationTurnId, conversationTurns.id),
          eq(outboxMessages.conversationTurnRevision, conversationTurns.revision),
          eq(outboxMessages.state, "accepted")
        )
      )
      .innerJoin(
        deliveryAttempts,
        and(
          eq(deliveryAttempts.outboxId, outboxMessages.id),
          eq(deliveryAttempts.state, "delivered")
        )
      )
      .where(
        and(
          eq(conversationTurns.userId, input.ownerId),
          eq(conversationTurns.channelId, input.channelId),
          eq(conversationTurns.status, "replied"),
          ne(conversationTurns.id, input.currentConversationTurnId),
          gte(deliveryAttempts.updatedAt, deliveredAfter),
          lte(deliveryAttempts.updatedAt, input.localTime)
        )
      )
      .orderBy(desc(deliveryAttempts.updatedAt))
      .limit(4)

    const newestItems: ContextItem[] = []
    let messageCount = 0
    for (const turn of priorTurns) {
      const remainingMessages = 6 - messageCount
      if (remainingMessages < 2) break
      const inboundRows = await database
        .select({
          id: messages.id,
          textCiphertext: messages.textCiphertext,
          textIv: messages.textIv,
          occurredAt: messages.occurredAt
        })
        .from(conversationTurnMessages)
        .innerJoin(messages, eq(messages.id, conversationTurnMessages.messageId))
        .where(
          and(
            eq(conversationTurnMessages.turnId, turn.id),
            lte(conversationTurnMessages.revision, turn.revision),
            eq(messages.direction, "inbound")
          )
        )
        .orderBy(asc(messages.occurredAt), asc(messages.createdAt), asc(messages.id))
      const [outbound] = await database
        .select({
          id: messages.id,
          textCiphertext: messages.textCiphertext,
          textIv: messages.textIv,
          occurredAt: messages.occurredAt
        })
        .from(messages)
        .where(and(eq(messages.id, turn.outboundMessageId), eq(messages.direction, "outbound")))
        .limit(1)
      if (inboundRows.length === 0 || outbound === undefined) continue
      const inboundTexts = await Promise.all(
        inboundRows.map((message) =>
          protection.decryptText(key, {
            ciphertext: message.textCiphertext,
            iv: message.textIv
          })
        )
      )
      const outboundText = await protection.decryptText(key, {
        ciphertext: outbound.textCiphertext,
        iv: outbound.textIv
      })
      if ([...inboundTexts, outboundText].some(hasJournalIntent)) continue
      const selectedInboundRows = inboundRows.slice(-(remainingMessages - 1))
      const selectedInboundTexts = inboundTexts.slice(-(remainingMessages - 1))
      messageCount += selectedInboundRows.length + 1
      newestItems.push({
        kind: "conversation",
        text: [
          ...selectedInboundTexts.map((text) => `Owner: ${text}`),
          `Bob: ${outboundText}`
        ].join("\n"),
        instruction: false,
        conflict: false,
        sources: [
          ...selectedInboundRows.map((message) => ({
            sourceId: message.id,
            sourceLabel: `owner message ${sourceDay(message.occurredAt)}`,
            occurredAt: message.occurredAt
          })),
          {
            sourceId: outbound.id,
            sourceLabel: `Bob reply ${sourceDay(outbound.occurredAt)}`,
            occurredAt: outbound.occurredAt
          }
        ]
      })
    }
    return boundContextItems(newestItems, 2_400, itemCharacterBudget).toReversed()
  }

  async function inlineReplyContext(
    input: ContextBuildRequest,
    key: CryptoKey
  ): Promise<ContextItem[]> {
    const [parent] = await database
      .select({
        id: messages.id,
        textCiphertext: messages.textCiphertext,
        textIv: messages.textIv,
        occurredAt: messages.occurredAt
      })
      .from(inboundEvents)
      .innerJoin(
        deliveryAttempts,
        eq(deliveryAttempts.providerMessageHandle, inboundEvents.replyToProviderMessageHandle)
      )
      .innerJoin(
        outboxMessages,
        and(
          eq(outboxMessages.id, deliveryAttempts.outboxId),
          eq(outboxMessages.userId, input.ownerId),
          eq(outboxMessages.channelId, input.channelId),
          eq(outboxMessages.state, "accepted")
        )
      )
      .innerJoin(
        messages,
        and(eq(messages.id, outboxMessages.messageId), eq(messages.direction, "outbound"))
      )
      .where(
        and(
          eq(inboundEvents.userId, input.ownerId),
          eq(inboundEvents.channelId, input.channelId),
          eq(inboundEvents.messageId, input.currentMessageId),
          isNotNull(inboundEvents.replyToProviderMessageHandle),
          inArray(deliveryAttempts.state, ["accepted", "delivered"])
        )
      )
      .orderBy(desc(deliveryAttempts.updatedAt))
      .limit(1)
    if (parent === undefined) return []
    const text = await protection.decryptText(key, {
      ciphertext: parent.textCiphertext,
      iv: parent.textIv
    })
    if (hasJournalIntent(text)) return []
    return [
      {
        kind: "conversation",
        text: `Bob (message replied to): ${text}`,
        instruction: false,
        conflict: false,
        sources: [
          {
            sourceId: parent.id,
            sourceLabel: `Bob reply ${sourceDay(parent.occurredAt)}`,
            occurredAt: parent.occurredAt
          }
        ]
      }
    ]
  }

  async function toolReceiptContext(
    input: ContextBuildRequest,
    key: CryptoKey
  ): Promise<ContextItem[]> {
    if (
      input.currentConversationTurnId === undefined ||
      input.currentConversationTurnRevision === undefined
    ) {
      return []
    }
    const rows = await database
      .select({
        toolName: toolCalls.toolName,
        resultJson: toolCalls.resultJson
      })
      .from(toolCalls)
      .innerJoin(agentRuns, eq(agentRuns.id, toolCalls.runId))
      .where(
        and(
          eq(agentRuns.userId, input.ownerId),
          eq(agentRuns.conversationTurnId, input.currentConversationTurnId),
          lt(agentRuns.conversationTurnRevision, input.currentConversationTurnRevision),
          inArray(toolCalls.status, ["completed", "failed", "unknown"]),
          isNotNull(toolCalls.resultJson)
        )
      )
      .orderBy(desc(toolCalls.completedAt), desc(toolCalls.createdAt))
      .limit(8)

    const receipts: ContextItem[] = []
    for (const row of rows.toReversed()) {
      try {
        const envelope = JSON.parse(row.resultJson!) as { ciphertext: string; iv: string }
        const result = Schema.decodeUnknownSync(ToolResult)(
          JSON.parse(await protection.decryptText(key, envelope)) as unknown
        )
        const toolName = Schema.decodeUnknownSync(ToolName)(row.toolName)
        const receipt = Schema.decodeUnknownSync(PriorToolReceipt)({
          origin: "same_turn",
          toolName,
          result: { ok: result.ok, code: result.code }
        })
        receipts.push({
          kind: "conversation",
          text: `Earlier revision action record. Do not repeat an identical completed mutation. ${JSON.stringify(receipt)}`,
          instruction: false,
          conflict: false,
          sources: []
        })
      } catch {
        // A malformed private receipt is skipped. It never changes the workflow.
      }
    }
    return receipts
  }

  async function lexicalContext(ownerId: string, text: string): Promise<ContextItem[]> {
    const query = buildFtsQuery(text)
    if (query === undefined) return []
    const rows = await database.all<{
      document_id: string
      text: string
      source_type: string
      source_id: string
      source_label: string
      occurred_at: string | null
      importance: number
      lexical_rank: number
    }>(sql`
      SELECT
        f.document_id,
        f.text,
        d.source_type,
        d.source_id,
        f.source_label,
        d.occurred_at,
        d.importance,
        bm25(search_documents_fts) AS lexical_rank
      FROM search_documents_fts AS f
      JOIN search_documents AS d ON d.id = f.document_id
      WHERE search_documents_fts MATCH ${query}
        AND f.user_id = ${ownerId}
        AND d.deleted_at IS NULL
        AND d.model_eligible = 1
        AND d.channel_eligible = 1
      ORDER BY lexical_rank, d.importance DESC, d.occurred_at DESC
      LIMIT 24
    `)

    const selected: ContextItem[] = []
    const sourceCounts = new Map<string, number>()
    let usedCharacters = 0
    for (const row of rows) {
      const count = sourceCounts.get(row.source_type) ?? 0
      if (count >= 3) continue
      if (usedCharacters + row.text.length > retrievalCharacterBudget) continue
      sourceCounts.set(row.source_type, count + 1)
      usedCharacters += row.text.length
      selected.push({
        kind: contextKind(row.source_type),
        text: row.text,
        instruction: false,
        conflict: false,
        sources: [
          {
            sourceId: row.source_id,
            sourceLabel: row.source_label,
            ...(row.occurred_at === null ? {} : { occurredAt: row.occurred_at })
          }
        ]
      })
      if (selected.length >= retrievalLimit) break
    }
    return selected
  }

  async function artifactContext(
    ownerId: string,
    channelId: string,
    key: CryptoKey
  ): Promise<ContextItem[]> {
    const [latestArtifact] = await database
      .select({ artifact: artifacts, revision: artifactRevisions })
      .from(artifacts)
      .innerJoin(
        artifactRevisions,
        and(
          eq(artifactRevisions.artifactId, artifacts.id),
          eq(artifactRevisions.revision, artifacts.currentRevision)
        )
      )
      .where(and(eq(artifacts.userId, ownerId), eq(artifacts.channelId, channelId)))
      .orderBy(desc(artifacts.updatedAt))
      .limit(1)
    if (latestArtifact === undefined) return []
    const text = await protection.decryptText(key, {
      ciphertext: latestArtifact.revision.renderedTextCiphertext,
      iv: latestArtifact.revision.renderedTextIv
    })
    return [
      {
        kind: "artifact",
        text: `Current plan:\n${text}`,
        instruction: false,
        conflict: false,
        sources: [
          {
            sourceId: `${latestArtifact.artifact.id}:revision:${latestArtifact.revision.revision}`,
            sourceLabel: `plan revision ${latestArtifact.revision.revision}`,
            occurredAt: latestArtifact.revision.createdAt
          }
        ]
      }
    ]
  }

  return {
    async priorToolReceipts(input) {
      if (
        input.currentConversationTurnId === undefined ||
        input.currentConversationTurnRevision === undefined
      ) {
        return []
      }
      const [currentTurn] = await database
        .select({ createdAt: conversationTurns.createdAt })
        .from(conversationTurns)
        .where(
          and(
            eq(conversationTurns.id, input.currentConversationTurnId),
            eq(conversationTurns.userId, input.ownerId),
            eq(conversationTurns.channelId, input.channelId)
          )
        )
        .limit(1)
      const predecessorBefore =
        currentTurn === undefined || Date.parse(currentTurn.createdAt) > Date.parse(input.localTime)
          ? input.localTime
          : currentTurn.createdAt
      const predecessorAfter = new Date(Date.parse(input.localTime) - 15 * 60_000).toISOString()
      const [predecessor] =
        currentTurn === undefined
          ? []
          : await database
              .select({ id: conversationTurns.id, revision: conversationTurns.revision })
              .from(conversationTurns)
              .innerJoin(
                outboxMessages,
                and(
                  eq(outboxMessages.id, conversationTurns.replyOutboxId),
                  eq(outboxMessages.conversationTurnId, conversationTurns.id),
                  eq(outboxMessages.conversationTurnRevision, conversationTurns.revision)
                )
              )
              .where(
                and(
                  eq(conversationTurns.userId, input.ownerId),
                  eq(conversationTurns.channelId, input.channelId),
                  eq(conversationTurns.status, "replied"),
                  ne(conversationTurns.id, input.currentConversationTurnId),
                  isNotNull(conversationTurns.repliedAt),
                  gte(conversationTurns.repliedAt, predecessorAfter),
                  lte(conversationTurns.repliedAt, predecessorBefore)
                )
              )
              .orderBy(
                desc(conversationTurns.repliedAt),
                desc(conversationTurns.updatedAt),
                desc(conversationTurns.id)
              )
              .limit(1)
      const currentTurnRevision = and(
        eq(agentRuns.conversationTurnId, input.currentConversationTurnId),
        lt(agentRuns.conversationTurnRevision, input.currentConversationTurnRevision)
      )
      const runAuthority =
        predecessor === undefined
          ? currentTurnRevision
          : or(
              currentTurnRevision,
              and(
                eq(agentRuns.conversationTurnId, predecessor.id),
                eq(agentRuns.conversationTurnRevision, predecessor.revision)
              )
            )
      const rows = await database
        .select({
          conversationTurnId: agentRuns.conversationTurnId,
          toolName: toolCalls.toolName,
          resultJson: toolCalls.resultJson
        })
        .from(toolCalls)
        .innerJoin(agentRuns, eq(agentRuns.id, toolCalls.runId))
        .where(
          and(
            eq(agentRuns.userId, input.ownerId),
            runAuthority,
            inArray(toolCalls.status, ["completed", "failed", "unknown"]),
            isNotNull(toolCalls.resultJson)
          )
        )
        .orderBy(desc(toolCalls.completedAt), desc(toolCalls.createdAt))
        .limit(8)
      const key = await ownerKey(input.ownerId)
      const receipts: (typeof PriorToolReceipt.Type)[] = []
      for (const row of rows.toReversed()) {
        try {
          const envelope = JSON.parse(row.resultJson!) as { ciphertext: string; iv: string }
          const result = Schema.decodeUnknownSync(ToolResult)(
            JSON.parse(await protection.decryptText(key, envelope)) as unknown
          )
          receipts.push(
            Schema.decodeUnknownSync(PriorToolReceipt)({
              origin:
                row.conversationTurnId === input.currentConversationTurnId
                  ? "same_turn"
                  : "predecessor_turn",
              toolName: Schema.decodeUnknownSync(ToolName)(row.toolName),
              result: { ok: result.ok, code: result.code }
            })
          )
        } catch {
          // Malformed private receipts do not enter the Agent request.
        }
      }
      return receipts
    },

    async build(inputOrOwnerId, legacyChannelId) {
      const input: ContextBuildRequest =
        typeof inputOrOwnerId === "string"
          ? {
              ownerId: inputOrOwnerId,
              channelId: legacyChannelId ?? "",
              currentMessageId: "legacy-storage-test",
              currentUserText: "",
              localTime: new Date(0).toISOString(),
              timeZone: "UTC"
            }
          : inputOrOwnerId
      const key = await ownerKey(input.ownerId)
      const profile = await profileContext(input.ownerId, key)
      const inlineReply = await inlineReplyContext(input, key)
      const repliedToSourceIds = new Set(
        inlineReply.flatMap((item) => item.sources.map((source) => source.sourceId))
      )
      const conversation = (await conversationContext(input, key)).filter((item) =>
        item.sources.every((source) => !repliedToSourceIds.has(source.sourceId))
      )
      const toolReceipts = await toolReceiptContext(input, key)
      const artifactItems = await artifactContext(input.ownerId, input.channelId, key)
      const lexical = await lexicalContext(input.ownerId, input.currentUserText)
      const seenSources = new Set(
        [...inlineReply, ...profile, ...conversation, ...toolReceipts, ...artifactItems].flatMap(
          (item) => item.sources.map((source) => source.sourceId)
        )
      )
      const uniqueLexical = lexical.filter((item) =>
        item.sources.every((source) => !seenSources.has(source.sourceId))
      )
      const boundedReceipts = boundContextItems(
        toolReceipts.toReversed(),
        totalCharacterBudget,
        itemCharacterBudget
      ).toReversed()
      const receiptCharacters = boundedReceipts.reduce((total, item) => total + item.text.length, 0)
      const otherItems = boundContextItems(
        [...inlineReply, ...profile, ...conversation, ...artifactItems, ...uniqueLexical],
        totalCharacterBudget - receiptCharacters,
        itemCharacterBudget
      )
      return Object.freeze([...otherItems, ...boundedReceipts])
    }
  }
}

export function contextStoreLayer(store: ContextStore) {
  return Layer.succeed(ContextStore, store)
}
