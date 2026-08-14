import { PriorToolReceipt, type ContextItem } from "@bob/contracts/agent"
import { isReadOnlyToolName, ToolName, ToolResult } from "@bob/contracts/tools"
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
  messages,
  toolCalls,
  users
} from "../conversations/schema.ts"
import { deliveryAttempts, outboxMessages } from "../delivery/schema.ts"
import { buildFtsQuery } from "../memory/retrieval.ts"
import { factEvidence, factRevisions, facts } from "../memory/schema.ts"
import { reminderOccurrences, reminders } from "../reminders/schema.ts"
import { exercises, routines, routineSteps, workoutSessions } from "../training/schema.ts"

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
  recentToolCapabilities(input: ContextBuildRequest): Promise<readonly ToolName[]>
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

function isReminderTask(text: string): boolean {
  return /\bremind(?:er|ers|ing)?\b|\bsnooze\b|\bdue\b|\bpåminn(?:else(?:n|r|rna)?|a|er|t)?\b|\bsnooza?\b|\bsenarelägg\b|\bskjut(?:a)?\s+upp\b|\bförfaller\b|\bdags\b/iu.test(
    text
  )
}

function isTrainingTask(text: string): boolean {
  return /\bgym\b|\broutine\b|\bworkout\b|\bexercise\b|\btraining\b|\bsets?\b|\brutin(?:en|er|erna)?\b|\btränings(?:rutin(?:en|er|erna)?|pass(?:et)?|plan(?:en)?|program(?:met)?)\b|\bövning(?:en|ar|arna)?\b|\bmaskin(?:en|er|erna)?\b|\butrustning(?:en)?\b/iu.test(
    text
  )
}

function hasJournalIntent(text: string): boolean {
  return /\b(?:journal(?:ing)?|diar(?:y|ies)|dagbok(?:en|ar|arna)?|dagboks)\b|\/journal\//iu.test(
    text
  )
}

const safeFollowUpCapabilities = new Set<ToolName>(["reminder_list"])

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

  async function reminderContext(ownerId: string, key: CryptoKey): Promise<ContextItem[]> {
    const rows = await database
      .select({ reminder: reminders, occurrence: reminderOccurrences })
      .from(reminders)
      .leftJoin(
        reminderOccurrences,
        and(
          eq(reminderOccurrences.reminderId, reminders.id),
          sql`${reminderOccurrences.state} IN ('scheduled', 'claimed', 'awaiting_delivery', 'awaiting_response', 'acknowledged')`
        )
      )
      .where(
        and(
          eq(reminders.userId, ownerId),
          eq(reminders.state, "active"),
          eq(reminders.sensitivity, "normal")
        )
      )
      .orderBy(asc(reminders.nextDueAt), asc(reminderOccurrences.intendedDueAt))
      .limit(4)

    return Promise.all(
      rows.map(async ({ reminder, occurrence }) => {
        const displayText = await protection.decryptText(key, {
          ciphertext: reminder.displayTextCiphertext,
          iv: reminder.displayTextIv
        })
        const dueAt = occurrence?.localDisplayTime ?? reminder.nextDueAt ?? "unscheduled"
        return {
          kind: "reminder" as const,
          text: `${displayText}. Due ${dueAt} ${reminder.timeZone}. State ${occurrence?.state ?? reminder.state}.`,
          instruction: false as const,
          conflict: false,
          sources: [
            {
              sourceId: occurrence?.id ?? reminder.id,
              sourceLabel: `reminder ${sourceDay(occurrence?.intendedDueAt ?? reminder.createdAt)}`,
              occurredAt: occurrence?.intendedDueAt ?? reminder.createdAt
            }
          ]
        }
      })
    )
  }

  async function trainingContext(
    ownerId: string,
    channelId: string,
    key: CryptoKey
  ): Promise<ContextItem[]> {
    const routineRows = await database
      .select({ routine: routines, step: routineSteps, exercise: exercises })
      .from(routines)
      .leftJoin(routineSteps, eq(routineSteps.routineId, routines.id))
      .leftJoin(exercises, eq(exercises.id, routineSteps.exerciseId))
      .where(eq(routines.userId, ownerId))
      .orderBy(desc(routines.updatedAt), asc(routineSteps.position))
      .limit(40)

    const byRoutine = new Map<string, { routine: typeof routines.$inferSelect; steps: string[] }>()
    for (const row of routineRows) {
      const value = byRoutine.get(row.routine.id) ?? { routine: row.routine, steps: [] }
      if (row.step !== null) {
        const target = [
          row.step.targetSets === null ? undefined : `${row.step.targetSets} sets`,
          row.step.targetReps === null ? undefined : `${row.step.targetReps} reps`
        ]
          .filter((part): part is string => part !== undefined)
          .join(" × ")
        value.steps.push(
          `${row.step.position + 1}. ${row.exercise?.name ?? "Unknown exercise"}${target.length === 0 ? "" : ` (${target})`}`
        )
      }
      byRoutine.set(row.routine.id, value)
    }

    const items: ContextItem[] = [...byRoutine.values()].slice(0, 3).map(({ routine, steps }) => ({
      kind: "training" as const,
      text: `Routine ${routine.name}: ${steps.length === 0 ? "no steps" : steps.join("; ")}.`,
      instruction: false as const,
      conflict: false,
      sources: [
        {
          sourceId: routine.id,
          sourceLabel: `routine ${sourceDay(routine.updatedAt)}`,
          occurredAt: routine.updatedAt
        }
      ]
    }))

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
    if (latestArtifact !== undefined) {
      const text = await protection.decryptText(key, {
        ciphertext: latestArtifact.revision.renderedTextCiphertext,
        iv: latestArtifact.revision.renderedTextIv
      })
      items.unshift({
        kind: "training",
        text: `Current draft training plan:\n${text}`,
        instruction: false,
        conflict: false,
        sources: [
          {
            sourceId: `${latestArtifact.artifact.id}:revision:${latestArtifact.revision.revision}`,
            sourceLabel: `training plan revision ${latestArtifact.revision.revision}`,
            occurredAt: latestArtifact.revision.createdAt
          }
        ]
      })
    }

    const [active] = await database
      .select({ session: workoutSessions, routine: routines })
      .from(workoutSessions)
      .innerJoin(routines, eq(routines.id, workoutSessions.routineId))
      .where(and(eq(workoutSessions.userId, ownerId), eq(workoutSessions.status, "active")))
      .orderBy(desc(workoutSessions.startedAt))
      .limit(1)
    if (active !== undefined) {
      items.unshift({
        kind: "training",
        text: `Active workout for ${active.routine.name}, started ${active.session.startedAt}.`,
        instruction: false,
        conflict: false,
        sources: [
          {
            sourceId: active.session.id,
            sourceLabel: `workout ${sourceDay(active.session.startedAt)}`,
            occurredAt: active.session.startedAt
          }
        ]
      })
    }
    return items
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

    async recentToolCapabilities(input) {
      if (input.currentConversationTurnId === undefined) return []
      const deliveredAfter = new Date(Date.parse(input.localTime) - 15 * 60_000).toISOString()
      const [latestTurn] = await database
        .select({
          id: conversationTurns.id,
          revision: conversationTurns.revision
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
        .limit(1)

      if (latestTurn === undefined) return []
      const rows = await database
        .select({ toolName: toolCalls.toolName })
        .from(agentRuns)
        .innerJoin(
          toolCalls,
          and(eq(toolCalls.runId, agentRuns.id), eq(toolCalls.status, "completed"))
        )
        .where(
          and(
            eq(agentRuns.status, "completed"),
            eq(agentRuns.conversationTurnId, latestTurn.id),
            eq(agentRuns.conversationTurnRevision, latestTurn.revision)
          )
        )
        .orderBy(desc(toolCalls.completedAt), desc(toolCalls.createdAt))
        .limit(4)
      const capabilities: ToolName[] = []
      for (const row of rows) {
        try {
          const toolName = Schema.decodeUnknownSync(ToolName)(row.toolName)
          if (
            isReadOnlyToolName(toolName) &&
            safeFollowUpCapabilities.has(toolName) &&
            !capabilities.includes(toolName)
          ) {
            capabilities.push(toolName)
          }
        } catch {
          // Unknown tool metadata cannot expand the next run's capability set.
        }
      }
      return Object.freeze(capabilities)
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
      const conversation = await conversationContext(input, key)
      const toolReceipts = await toolReceiptContext(input, key)
      const taskItems = isReminderTask(input.currentUserText)
        ? await reminderContext(input.ownerId, key)
        : isTrainingTask(input.currentUserText)
          ? await trainingContext(input.ownerId, input.channelId, key)
          : []
      const lexical = await lexicalContext(input.ownerId, input.currentUserText)
      const seenSources = new Set(
        [...profile, ...conversation, ...toolReceipts, ...taskItems].flatMap((item) =>
          item.sources.map((source) => source.sourceId)
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
        [...profile, ...conversation, ...taskItems, ...uniqueLexical],
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
