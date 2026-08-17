import type { MemoryClass } from "@bob/memory-types/evidence"

import { Context, type Effect, Schema } from "effect"

export interface RetrievalCandidate {
  readonly id: string
  readonly sourceId: string
  readonly sourceType: string
  readonly memoryClass: MemoryClass
  readonly text: string
  readonly searchText?: string
  readonly contentHash?: string
  readonly sourceLabel: string
  readonly occurredAt?: string
  readonly conflictKey?: string
  readonly validFrom?: string
  readonly validTo?: string
  readonly importance: number
  readonly lexicalPosition: number
}

export type TemporalConstraint =
  | { readonly mode: "current"; readonly at: string }
  | { readonly mode: "as_of"; readonly at: string }
  | { readonly mode: "during"; readonly from: string; readonly to: string }

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
}

export type RetrievalUnit =
  | { readonly kind: "candidate"; readonly item: RetrievalItem }
  | {
      readonly kind: "conflict_group"
      readonly conflictKey: string
      readonly items: readonly [RetrievalItem, RetrievalItem, ...RetrievalItem[]]
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
      readonly items: readonly RetrievalUnit[]
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

export interface RetrievalPipelineAdapter {
  retrieve(input: RetrievalRequest): Promise<RetrievalResult>
}

export class RetrievalError extends Schema.TaggedError<RetrievalError>()("RetrievalError", {
  cause: Schema.Unknown
}) {}

export class RetrievalPipeline extends Context.Service<
  RetrievalPipeline,
  {
    readonly retrieve: (input: RetrievalRequest) => Effect.Effect<RetrievalResult, RetrievalError>
  }
>()("@bob/retrieval/RetrievalPipeline") {}
