import { Schema } from "effect"

import { IsoDateTime, NonEmptyText, Uuid } from "../shared.ts"

export const AdminStatus = Schema.Struct({
  configured: Schema.Boolean,
  provider: Schema.String,
  expiresAt: Schema.optionalKey(IsoDateTime),
  accountIdRedacted: Schema.optionalKey(Schema.String)
})

export const OperationalAlert = Schema.Struct({
  id: Uuid,
  code: NonEmptyText,
  objectType: NonEmptyText,
  objectId: NonEmptyText,
  state: Schema.Literals(["open", "reconciling", "resolved"]),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime
})

export const AlertList = Schema.Struct({ alerts: Schema.Array(OperationalAlert) })

export const MemoryCandidateReview = Schema.Struct({
  id: Uuid,
  memoryClass: Schema.Literal("owner_fact"),
  scope: NonEmptyText,
  key: NonEmptyText,
  value: Schema.Json,
  canonicalText: NonEmptyText,
  originClass: Schema.Literals([
    "owner_input",
    "system_record",
    "recalled_content",
    "tool_output",
    "assistant_output",
    "background_model"
  ]),
  sourceType: NonEmptyText,
  sourceId: NonEmptyText,
  sourceLabel: NonEmptyText,
  sensitivity: Schema.Literals(["normal", "private", "high"]),
  status: Schema.Literals(["proposed", "disputed"]),
  createdAt: IsoDateTime
})

export const MemoryCandidateList = Schema.Struct({
  candidates: Schema.Array(MemoryCandidateReview)
})

export const MemoryCandidateCorrection = Schema.Struct({ canonicalText: NonEmptyText })

export type AdminStatus = typeof AdminStatus.Type
export type OperationalAlert = typeof OperationalAlert.Type
export type AlertList = typeof AlertList.Type
export type MemoryCandidateReview = typeof MemoryCandidateReview.Type
export type MemoryCandidateList = typeof MemoryCandidateList.Type
export type MemoryCandidateCorrection = typeof MemoryCandidateCorrection.Type
