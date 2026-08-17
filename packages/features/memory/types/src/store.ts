import type { EffectAdapter } from "@bob/shared-types/effect-adapter"

import { Context, Schema } from "effect"

export type OriginClass =
  | "owner_input"
  | "system_record"
  | "recalled_content"
  | "tool_output"
  | "assistant_output"
  | "background_model"

export interface MemoryProposal {
  readonly ownerId: string
  readonly scope: string
  readonly key: string
  readonly value: unknown
  readonly canonicalText: string
  readonly sourceType: string
  readonly sourceId: string
  readonly extractionConfidence: number
  readonly importance: number
  readonly explicitRemember: boolean
  readonly authority: "agent" | "owner_deterministic" | "completed_system_command"
}

export interface MemoryCandidateReview {
  readonly id: string
  readonly memoryClass: "owner_fact"
  readonly scope: string
  readonly key: string
  readonly value: unknown
  readonly canonicalText: string
  readonly originClass: OriginClass
  readonly sourceType: string
  readonly sourceId: string
  readonly sourceLabel: string
  readonly sensitivity: "normal" | "private" | "high"
  readonly status: "proposed" | "disputed"
  readonly createdAt: string
}

export interface OwnerFactStore {
  propose(
    input: MemoryProposal,
    idempotencyKey: string
  ): Promise<{ candidateId: string; status: string }>
  confirm(
    ownerId: string,
    candidateId: string,
    authority: "owner_ui" | "completed_system_command",
    idempotencyKey: string
  ): Promise<string>
  correct(
    ownerId: string,
    candidateId: string,
    canonicalText: string,
    idempotencyKey: string
  ): Promise<string>
  reject(ownerId: string, candidateId: string, idempotencyKey: string): Promise<void>
  listCandidates(ownerId: string): Promise<readonly MemoryCandidateReview[]>
}

export type MemoryStoreAdapter = OwnerFactStore

export class MemoryStoreError extends Schema.TaggedError<MemoryStoreError>()("MemoryStoreError", {
  operation: Schema.String,
  cause: Schema.Unknown
}) {}

export class MemoryStore extends Context.Service<
  MemoryStore,
  EffectAdapter<MemoryStoreAdapter, MemoryStoreError>
>()("@bob/memory/MemoryStore") {}
