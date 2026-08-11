import type { ContextItem } from "@bob/contracts/agent"

import { and, asc, desc, eq, isNull, sql } from "drizzle-orm"
import { Context, Layer } from "effect"

import type { CoreDatabase } from "../../database.ts"
import type { DataProtection } from "../policy/data-protection.ts"

import { users } from "../conversations/schema.ts"
import { buildFtsQuery } from "../memory/retrieval.ts"
import { factEvidence, factRevisions, facts } from "../memory/schema.ts"
import { reminderOccurrences, reminders } from "../reminders/schema.ts"
import { exercises, routines, routineSteps, workoutSessions } from "../training/schema.ts"

export interface ContextBuildRequest {
  readonly ownerId: string
  readonly channelId: string
  readonly currentMessageId: string
  readonly currentUserText: string
  readonly localTime: string
  readonly timeZone: string
}

export interface ContextStore {
  /** String arguments remain valid for storage-safety tests and old snapshots. */
  build(input: ContextBuildRequest | string, channelId?: string): Promise<readonly ContextItem[]>
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

  async function trainingContext(ownerId: string): Promise<ContextItem[]> {
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

    const items = [...byRoutine.values()].slice(0, 3).map(({ routine, steps }) => ({
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
      const taskItems = isReminderTask(input.currentUserText)
        ? await reminderContext(input.ownerId, key)
        : isTrainingTask(input.currentUserText)
          ? await trainingContext(input.ownerId)
          : []
      const lexical = await lexicalContext(input.ownerId, input.currentUserText)
      const seenSources = new Set(
        [...profile, ...taskItems].flatMap((item) => item.sources.map((source) => source.sourceId))
      )
      const uniqueLexical = lexical.filter((item) =>
        item.sources.every((source) => !seenSources.has(source.sourceId))
      )
      return boundContextItems(
        [...profile, ...taskItems, ...uniqueLexical],
        totalCharacterBudget,
        itemCharacterBudget
      )
    }
  }
}

export function contextStoreLayer(store: ContextStore) {
  return Layer.succeed(ContextStore, store)
}
