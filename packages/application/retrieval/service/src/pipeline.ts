import type { CoreDatabase } from "@bob/db-types"

import { requiresPersonalGrounding } from "@bob/policy-types/output-safety"
import {
  RetrievalPipeline,
  type RetrievalPipelineAdapter,
  RetrievalError,
  type RetrievalItem,
  type RetrievalUnit
} from "@bob/retrieval-types/retrieval"
import { sql } from "drizzle-orm"
import { Effect, Layer, Schema } from "effect"

import {
  analyzeRetrievalQuery,
  boundRetrievalReading,
  selectRelevantCandidates,
  type RetrievalCandidate
} from "./rules.ts"

export type {
  RetrievalAbstentionReason,
  RetrievalItem,
  RetrievalPipelineAdapter,
  RetrievalRequest,
  RetrievalResult,
  RetrievalUnit
} from "@bob/retrieval-types/retrieval"
export { RetrievalPipeline } from "@bob/retrieval-types/retrieval"

const MemoryClassValue = Schema.Literals(["owner_fact", "owner_episode", "agent_experience"])

interface CandidateRow {
  [key: string]: unknown
  document_id: string
  source_id: string
  text: string
  search_text: string
  content_hash: string | null
  source_type: string
  source_label: string
  memory_class: string
  occurred_at: string | null
  conflict_key: string | null
  valid_from: string | null
  valid_to: string | null
  importance: number
}

function rowCandidate(row: CandidateRow, lexicalPosition: number): RetrievalCandidate {
  const candidate: RetrievalCandidate = {
    id: row.document_id,
    sourceId: row.source_id,
    sourceType: row.source_type,
    memoryClass: Schema.decodeUnknownSync(MemoryClassValue)(row.memory_class),
    text: row.text,
    searchText: row.search_text,
    sourceLabel: row.source_label,
    importance: row.importance,
    lexicalPosition
  }
  if (row.content_hash !== null) Object.assign(candidate, { contentHash: row.content_hash })
  if (row.occurred_at !== null) Object.assign(candidate, { occurredAt: row.occurred_at })
  if (row.conflict_key !== null) Object.assign(candidate, { conflictKey: row.conflict_key })
  if (row.valid_from !== null) Object.assign(candidate, { validFrom: row.valid_from })
  if (row.valid_to !== null) Object.assign(candidate, { validTo: row.valid_to })
  return candidate
}

function retrievalItem(candidate: RetrievalCandidate, includeConflictKey = true): RetrievalItem {
  const item: RetrievalItem = {
    id: candidate.id,
    sourceId: candidate.sourceId,
    sourceType: candidate.sourceType,
    memoryClass: candidate.memoryClass,
    text: candidate.text,
    sourceLabel: candidate.sourceLabel
  }
  if (candidate.occurredAt !== undefined) Object.assign(item, { occurredAt: candidate.occurredAt })
  if (includeConflictKey && candidate.conflictKey !== undefined) {
    Object.assign(item, { conflictKey: candidate.conflictKey })
  }
  return item
}

function retrievalConflictItems(
  candidates: readonly [RetrievalCandidate, RetrievalCandidate, ...RetrievalCandidate[]]
): readonly [RetrievalItem, RetrievalItem, ...RetrievalItem[]] {
  const [first, second, ...rest] = candidates
  return [
    retrievalItem(first, false),
    retrievalItem(second, false),
    ...rest.map((candidate) => retrievalItem(candidate, false))
  ]
}

function retrievalUnitCount(units: ReturnType<typeof selectRelevantCandidates>): number {
  return units.reduce(
    (count, unit) => count + (unit.kind === "conflict_group" ? unit.candidates.length : 1),
    0
  )
}

export function makeRetrievalPipeline(
  database: CoreDatabase,
  options: {
    readonly candidateLimit?: number
    readonly selectedLimit?: number
    readonly totalCharacterBudget?: number
    readonly itemCharacterBudget?: number
    readonly now?: () => Date
  } = {}
): RetrievalPipelineAdapter {
  const candidateLimit = options.candidateLimit ?? 48
  const selectedLimit = options.selectedLimit ?? 8
  const totalCharacterBudget = options.totalCharacterBudget ?? 2_400
  const itemCharacterBudget = options.itemCharacterBudget ?? 1_200
  const now = options.now ?? (() => new Date())

  return {
    async retrieve(input) {
      const analyzed = analyzeRetrievalQuery(input.query, input.referenceTime, input.timeZone)
      const allowBroadRecall = requiresPersonalGrounding(input.query)
      if (
        analyzed.ftsQuery === undefined &&
        analyzed.temporal.mode === "current" &&
        !allowBroadRecall
      ) {
        return {
          status: "abstain",
          reason: "no_query_terms",
          items: [],
          candidateCount: 0,
          relevantCount: 0,
          temporal: analyzed.temporal
        }
      }
      const rows =
        analyzed.ftsQuery === undefined
          ? await Effect.runPromise(
              database.execute<CandidateRow>(sql`
              SELECT
                d.id AS document_id,
                d.source_id,
                d.text,
                d.search_text,
                d.content_hash,
                d.source_type,
                d.source_label,
                d.memory_class,
                d.occurred_at,
                d.conflict_key,
                d.valid_from,
                d.valid_to,
                d.importance
              FROM search_documents AS d
              WHERE d.user_id = ${input.ownerId}
                AND d.deleted_at IS NULL
                AND d.model_eligible = true
                AND (${input.channel} = false OR d.channel_eligible = true)
              ORDER BY d.importance DESC, d.occurred_at DESC, d.id
              LIMIT ${candidateLimit}
            `)
            )
          : await Effect.runPromise(
              database.execute<CandidateRow>(sql`
              SELECT
                d.id AS document_id,
                d.source_id,
                d.text,
                d.search_text,
                d.content_hash,
                d.source_type,
                d.source_label,
                d.memory_class,
                d.occurred_at,
                d.conflict_key,
                d.valid_from,
                d.valid_to,
                d.importance
              FROM search_documents AS d
              WHERE to_tsvector('simple', d.search_text || ' ' || d.source_label)
                @@ websearch_to_tsquery('simple', ${analyzed.ftsQuery})
                AND d.user_id = ${input.ownerId}
                AND d.deleted_at IS NULL
                AND d.model_eligible = true
                AND (${input.channel} = false OR d.channel_eligible = true)
              ORDER BY
                ts_rank(
                  to_tsvector('simple', d.search_text || ' ' || d.source_label),
                  websearch_to_tsquery('simple', ${analyzed.ftsQuery})
                ) DESC,
                d.importance DESC,
                d.id
              LIMIT ${candidateLimit}
            `)
            )
      if (rows.length === 0) {
        const policyRows =
          analyzed.ftsQuery === undefined
            ? await Effect.runPromise(
                database.execute<{ document_id: string }>(sql`
                SELECT d.id AS document_id
                FROM search_documents AS d
                WHERE d.user_id = ${input.ownerId}
                  AND d.deleted_at IS NULL
                LIMIT 1
              `)
              )
            : await Effect.runPromise(
                database.execute<{ document_id: string }>(sql`
                SELECT d.id AS document_id
                FROM search_documents AS d
                WHERE to_tsvector('simple', d.search_text || ' ' || d.source_label)
                  @@ websearch_to_tsquery('simple', ${analyzed.ftsQuery})
                  AND d.user_id = ${input.ownerId}
                  AND d.deleted_at IS NULL
                LIMIT 1
              `)
              )
        return {
          status: "abstain",
          reason: policyRows.length === 0 ? "no_candidates" : "policy_filtered",
          items: [],
          candidateCount: 0,
          relevantCount: 0,
          temporal: analyzed.temporal
        }
      }
      const relevant = selectRelevantCandidates(
        rows.map(rowCandidate),
        analyzed.terms,
        analyzed.temporal,
        {
          nowMs: now().getTime(),
          limit: input.limit ?? selectedLimit
        }
      )
      if (relevant.length === 0) {
        return {
          status: "abstain",
          reason: "no_relevant_candidates",
          items: [],
          candidateCount: rows.length,
          relevantCount: 0,
          temporal: analyzed.temporal
        }
      }
      const bounded = boundRetrievalReading(relevant, {
        totalCharacters: input.totalCharacterBudget ?? totalCharacterBudget,
        itemCharacters: input.itemCharacterBudget ?? itemCharacterBudget
      })
      const relevantCount = retrievalUnitCount(relevant)
      if (bounded.length === 0) {
        return {
          status: "abstain",
          reason: "reading_budget_exhausted",
          items: [],
          candidateCount: rows.length,
          relevantCount,
          temporal: analyzed.temporal
        }
      }
      return {
        status: "supported",
        items: bounded.map((unit): RetrievalUnit =>
          unit.kind === "candidate"
            ? { kind: "candidate", item: retrievalItem(unit.candidate) }
            : {
                kind: "conflict_group",
                conflictKey: unit.conflictKey,
                items: retrievalConflictItems(unit.candidates)
              }
        ),
        candidateCount: rows.length,
        relevantCount,
        temporal: analyzed.temporal
      }
    }
  }
}

export function retrievalPipelineLayer(pipeline: RetrievalPipelineAdapter) {
  return Layer.succeed(RetrievalPipeline, {
    retrieve: Effect.fnUntraced(function* (input) {
      return yield* Effect.tryPromise({
        try: () => pipeline.retrieve(input),
        catch: (cause) => new RetrievalError({ cause })
      })
    })
  })
}
