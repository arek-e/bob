import { requiresPersonalGrounding } from "@bob/contracts/output-safety"
import { sql } from "drizzle-orm"
import { Context, Layer, Schema } from "effect"

import type { CoreDatabase } from "../../database.ts"
import type { MemoryClass } from "../memory/evidence.ts"

import {
  analyzeRetrievalQuery,
  boundRetrievalReading,
  selectRelevantCandidates,
  type RetrievalCandidate,
  type TemporalConstraint
} from "./rules.ts"

const MemoryClassValue = Schema.Literals(["owner_fact", "owner_episode", "agent_experience"])

export interface RetrievalRequest {
  readonly ownerId: string
  readonly query: string
  readonly channel: boolean
  readonly referenceTime: string
  readonly timeZone: string
  readonly limit?: number
  readonly totalCharacterBudget?: number
  readonly itemCharacterBudget?: number
}

export interface RetrievalItem {
  readonly id: string
  readonly sourceId: string
  readonly sourceType: string
  readonly memoryClass: MemoryClass
  readonly text: string
  readonly sourceLabel: string
  readonly occurredAt?: string
  readonly conflictKey?: string
  readonly conflict: boolean
}

export type RetrievalAbstentionReason =
  | "no_query_terms"
  | "no_candidates"
  | "policy_filtered"
  | "no_relevant_candidates"
  | "reading_budget_exhausted"

export type RetrievalResult =
  | {
      readonly status: "supported"
      readonly items: readonly RetrievalItem[]
      readonly candidateCount: number
      readonly relevantCount: number
      readonly temporal: TemporalConstraint
    }
  | {
      readonly status: "abstain"
      readonly reason: RetrievalAbstentionReason
      readonly items: readonly []
      readonly candidateCount: number
      readonly relevantCount: number
      readonly temporal: TemporalConstraint
    }

export interface RetrievalPipeline {
  retrieve(input: RetrievalRequest): Promise<RetrievalResult>
}

export const RetrievalPipeline = Context.Service<RetrievalPipeline>("bob/RetrievalPipeline")

interface CandidateRow {
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

export function makeRetrievalPipeline(
  database: CoreDatabase,
  options: {
    readonly candidateLimit?: number
    readonly selectedLimit?: number
    readonly totalCharacterBudget?: number
    readonly itemCharacterBudget?: number
    readonly now?: () => Date
  } = {}
): RetrievalPipeline {
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
          ? await database.all<CandidateRow>(sql`
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
                AND d.model_eligible = 1
                AND (${input.channel ? 1 : 0} = 0 OR d.channel_eligible = 1)
              ORDER BY d.importance DESC, d.occurred_at DESC, d.id
              LIMIT ${candidateLimit}
            `)
          : await database.all<CandidateRow>(sql`
              SELECT
                f.document_id,
                d.source_id,
                d.text,
                d.search_text,
                d.content_hash,
                d.source_type,
                f.source_label,
                d.memory_class,
                d.occurred_at,
                d.conflict_key,
                d.valid_from,
                d.valid_to,
                d.importance
              FROM retrieval_documents_fts AS f
              JOIN search_documents AS d ON d.id = f.document_id
              WHERE retrieval_documents_fts MATCH ${analyzed.ftsQuery}
                AND f.user_id = ${input.ownerId}
                AND d.deleted_at IS NULL
                AND d.model_eligible = 1
                AND (${input.channel ? 1 : 0} = 0 OR d.channel_eligible = 1)
              ORDER BY bm25(retrieval_documents_fts), d.importance DESC, d.id
              LIMIT ${candidateLimit}
            `)
      if (rows.length === 0) {
        const policyRows =
          analyzed.ftsQuery === undefined
            ? await database.all<{ document_id: string }>(sql`
                SELECT d.id AS document_id
                FROM search_documents AS d
                WHERE d.user_id = ${input.ownerId}
                  AND d.deleted_at IS NULL
                LIMIT 1
              `)
            : await database.all<{ document_id: string }>(sql`
                SELECT f.document_id
                FROM retrieval_documents_fts AS f
                JOIN search_documents AS d ON d.id = f.document_id
                WHERE retrieval_documents_fts MATCH ${analyzed.ftsQuery}
                  AND f.user_id = ${input.ownerId}
                  AND d.deleted_at IS NULL
                LIMIT 1
              `)
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
      if (bounded.length === 0) {
        return {
          status: "abstain",
          reason: "reading_budget_exhausted",
          items: [],
          candidateCount: rows.length,
          relevantCount: relevant.length,
          temporal: analyzed.temporal
        }
      }
      return {
        status: "supported",
        items: bounded.map(
          ({
            id,
            sourceId,
            sourceType,
            memoryClass,
            text,
            sourceLabel,
            occurredAt,
            conflictKey,
            conflict
          }) => {
            const item: RetrievalItem = {
              id,
              sourceId,
              sourceType,
              memoryClass,
              text,
              sourceLabel,
              conflict
            }
            if (occurredAt !== undefined) Object.assign(item, { occurredAt })
            if (conflictKey !== undefined) Object.assign(item, { conflictKey })
            return item
          }
        ),
        candidateCount: rows.length,
        relevantCount: relevant.length,
        temporal: analyzed.temporal
      }
    }
  }
}

export function retrievalPipelineLayer(pipeline: RetrievalPipeline) {
  return Layer.succeed(RetrievalPipeline, pipeline)
}
