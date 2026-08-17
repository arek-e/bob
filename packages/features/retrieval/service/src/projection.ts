import type { MemoryClass } from "@bob/memory-types/evidence"

export interface RetrievalProjectionInput {
  readonly id: string
  readonly ownerId: string
  readonly sourceType: string
  readonly sourceId: string
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
  readonly sensitivity: string
  readonly modelEligible: boolean
  readonly channelEligible: boolean
  readonly createdAt: string
  readonly updatedAt?: string
}

interface RetrievalProjectionRecord {
  id: string
  userId: string
  sourceType: string
  sourceId: string
  memoryClass: MemoryClass
  text: string
  searchText: string
  sourceLabel: string
  importance: number
  sensitivity: string
  modelEligible: boolean
  channelEligible: boolean
  createdAt: string
  updatedAt: string
  contentHash?: string
  occurredAt?: string
  conflictKey?: string
  validFrom?: string
  validTo?: string
}

function required(value: string, name: string, maximum: number): string {
  const normalized = value.normalize("NFKC").trim()
  if (normalized.length === 0 || normalized.length > maximum) {
    throw new Error(`Retrieval ${name} is invalid`)
  }
  return normalized
}

function instant(value: string | undefined, name: string): string | undefined {
  if (value === undefined) return undefined
  if (!Number.isFinite(Date.parse(value))) throw new Error(`Retrieval ${name} is invalid`)
  return value
}

/**
 * Build one policy-cleared search projection.
 *
 * Source-owning Modules keep record authority. This function owns the common
 * index shape and rejects data that the bounded reader cannot consume safely.
 */
export function retrievalProjection(input: RetrievalProjectionInput) {
  const occurredAt = instant(input.occurredAt, "occurrence time")
  const validFrom = instant(input.validFrom, "valid-from time")
  const validTo = instant(input.validTo, "valid-to time")
  if (
    validFrom !== undefined &&
    validTo !== undefined &&
    Date.parse(validFrom) >= Date.parse(validTo)
  ) {
    throw new Error("Retrieval validity interval is invalid")
  }
  if (!Number.isInteger(input.importance) || input.importance < 0 || input.importance > 1_000) {
    throw new Error("Retrieval importance is invalid")
  }
  const projection: RetrievalProjectionRecord = {
    id: required(input.id, "document ID", 160),
    userId: required(input.ownerId, "owner ID", 160),
    sourceType: required(input.sourceType, "source type", 120),
    sourceId: required(input.sourceId, "source ID", 240),
    memoryClass: input.memoryClass,
    text: required(input.text, "text", 8_000),
    searchText: required(input.searchText ?? input.text, "search text", 12_000),
    sourceLabel: required(input.sourceLabel, "source label", 240),
    importance: input.importance,
    sensitivity: required(input.sensitivity, "sensitivity", 40),
    modelEligible: input.modelEligible,
    channelEligible: input.channelEligible,
    createdAt: instant(input.createdAt, "creation time")!,
    updatedAt: instant(input.updatedAt ?? input.createdAt, "update time")!
  }
  if (input.contentHash !== undefined) {
    projection.contentHash = required(input.contentHash, "content hash", 240)
  }
  if (occurredAt !== undefined) projection.occurredAt = occurredAt
  if (input.conflictKey !== undefined) {
    projection.conflictKey = required(input.conflictKey, "conflict key", 240)
  }
  if (validFrom !== undefined) projection.validFrom = validFrom
  if (validTo !== undefined) projection.validTo = validTo
  return projection
}
