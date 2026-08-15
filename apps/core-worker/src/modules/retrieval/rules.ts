import { Temporal } from "@js-temporal/polyfill"

import type { MemoryClass } from "../memory/evidence.ts"

const stopWords = new Set([
  "a",
  "about",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "before",
  "by",
  "did",
  "do",
  "does",
  "for",
  "from",
  "have",
  "i",
  "in",
  "is",
  "it",
  "know",
  "me",
  "my",
  "of",
  "on",
  "or",
  "say",
  "show",
  "tell",
  "that",
  "the",
  "to",
  "was",
  "what",
  "when",
  "where",
  "which",
  "who",
  "you",
  "yesterday",
  "är",
  "berätta",
  "det",
  "har",
  "idag",
  "igår",
  "i",
  "jag",
  "min",
  "mina",
  "mitt",
  "om",
  "på",
  "sa",
  "vad",
  "var",
  "visa",
  "today"
])

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

export interface AnalyzedRetrievalQuery {
  readonly terms: readonly string[]
  readonly ftsQuery?: string
  readonly temporal: TemporalConstraint
}

function tokens(text: string): readonly string[] {
  return [
    ...new Set(
      text
        .normalize("NFKC")
        .toLocaleLowerCase("en")
        .match(/[\p{L}\p{N}]+/gu) ?? []
    )
  ]
}

function dayInterval(date: Temporal.PlainDate, timeZone: string) {
  const from = date.toZonedDateTime({ timeZone, plainTime: "00:00:00" }).toInstant().toString()
  const to = date.add({ days: 1 }).toZonedDateTime({ timeZone, plainTime: "00:00:00" })
  return { from, to: to.toInstant().toString() }
}

/** Analyze temporal intent and build a literal FTS5 query from untrusted text. */
export function analyzeRetrievalQuery(
  text: string,
  referenceTime: string,
  timeZone: string
): AnalyzedRetrievalQuery {
  const reference = Temporal.Instant.from(referenceTime).toZonedDateTimeISO(timeZone)
  const normalized = text.normalize("NFKC").toLocaleLowerCase("en")
  const explicitDate = normalized.match(/\b(\d{4}-\d{2}-\d{2})\b/u)?.[1]
  const relativeDate = /\b(?:yesterday|igår)\b/iu.test(normalized)
    ? reference.toPlainDate().subtract({ days: 1 })
    : /\b(?:today|idag)\b/iu.test(normalized)
      ? reference.toPlainDate()
      : undefined
  let explicitPlainDate: Temporal.PlainDate | undefined
  if (explicitDate !== undefined) {
    try {
      explicitPlainDate = Temporal.PlainDate.from(explicitDate)
    } catch {
      explicitPlainDate = undefined
    }
  }
  const date = explicitDate === undefined ? relativeDate : explicitPlainDate
  let temporal: TemporalConstraint = { mode: "current", at: reference.toInstant().toString() }
  if (date !== undefined) {
    const interval = dayInterval(date, timeZone)
    temporal = /\b(?:as of|before|by|före|senast)\b/iu.test(normalized)
      ? {
          mode: "as_of",
          at: Temporal.Instant.from(interval.to).subtract({ milliseconds: 1 }).toString()
        }
      : { mode: "during", ...interval }
  }
  const terms = tokens(normalized)
    .filter((token) => !stopWords.has(token))
    .filter((token) => explicitDate?.split("-").includes(token) !== true)
    .filter((token) => token.length >= 2 || /^\d+$/u.test(token))
    .slice(0, 12)
  if (terms.length === 0) return { terms, temporal }
  return {
    terms,
    ftsQuery: terms.map((token) => `"${token.replaceAll('"', '""')}"`).join(" OR "),
    temporal
  }
}

/** Build a literal FTS5 query. Kept as a small testable rule for untrusted input. */
export function buildFtsQuery(text: string): string | undefined {
  const terms = tokens(text)
    .filter((token) => token.length >= 2 || /^\d+$/u.test(token))
    .slice(0, 12)
  if (terms.length === 0) return undefined
  return terms.map((token) => `"${token.replaceAll('"', '""')}"`).join(" OR ")
}

function instant(value: string | undefined): number | undefined {
  if (value === undefined) return undefined
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

export function matchesTemporalConstraint(
  candidate: RetrievalCandidate,
  constraint: TemporalConstraint
): boolean {
  const validFrom = instant(candidate.validFrom) ?? Number.NEGATIVE_INFINITY
  const validTo = instant(candidate.validTo) ?? Number.POSITIVE_INFINITY
  if (constraint.mode === "current" || constraint.mode === "as_of") {
    const at = Date.parse(constraint.at)
    return validFrom <= at && at < validTo
  }
  if (candidate.memoryClass === "owner_fact") {
    const at = Date.parse(constraint.to) - 1
    return validFrom <= at && at < validTo
  }
  const occurredAt = instant(candidate.occurredAt)
  return (
    occurredAt !== undefined &&
    Date.parse(constraint.from) <= occurredAt &&
    occurredAt < Date.parse(constraint.to)
  )
}

function relevance(candidate: RetrievalCandidate, terms: readonly string[]): number {
  if (terms.length === 0) return 1
  const candidateTerms = new Set(tokens(candidate.searchText ?? candidate.text))
  const matched = terms.filter((term) => candidateTerms.has(term)).length
  return matched / terms.length
}

function recencyScore(candidate: RetrievalCandidate, nowMs: number): number {
  if (candidate.memoryClass === "owner_fact") return 1
  const occurredAt = instant(candidate.occurredAt)
  if (occurredAt === undefined) return 0
  const ageDays = Math.max(0, (nowMs - occurredAt) / 86_400_000)
  return Math.exp((-Math.log(2) * ageDays) / 90)
}

export interface RankedRetrievalCandidate extends RetrievalCandidate {
  readonly relevance: number
  readonly conflict: boolean
}

/**
 * Filter and rank candidates, then mark simultaneous values for one key as a conflict.
 */
export function selectRelevantCandidates(
  candidates: readonly RetrievalCandidate[],
  terms: readonly string[],
  temporal: TemporalConstraint,
  options: {
    readonly nowMs?: number
    readonly limit?: number
    readonly perMemoryClass?: number
    readonly minimumRelevance?: number
  } = {}
): readonly RankedRetrievalCandidate[] {
  const nowMs = options.nowMs ?? Date.now()
  const limit = options.limit ?? 12
  const perMemoryClass = options.perMemoryClass ?? 8
  const minimumRelevance = options.minimumRelevance ?? (terms.length <= 2 ? 0.5 : 0.34)
  const ranked = candidates
    .filter((candidate) => matchesTemporalConstraint(candidate, temporal))
    .map((candidate) => ({ candidate, relevance: relevance(candidate, terms) }))
    .filter(({ relevance: score }) => score >= minimumRelevance)
    .map(({ candidate, relevance: score }) => ({
      candidate,
      relevance: score,
      score:
        0.45 * score +
        0.3 / (candidate.lexicalPosition + 1) +
        0.15 * Math.max(0, Math.min(1, candidate.importance / 1_000)) +
        0.1 * recencyScore(candidate, nowMs)
    }))
    .sort(
      (left, right) =>
        right.score - left.score ||
        left.candidate.lexicalPosition - right.candidate.lexicalPosition ||
        left.candidate.id.localeCompare(right.candidate.id)
    )

  const valuesByKey = new Map<string, Set<string>>()
  for (const { candidate } of ranked) {
    if (candidate.conflictKey === undefined) continue
    const values = valuesByKey.get(candidate.conflictKey) ?? new Set<string>()
    values.add(
      candidate.contentHash ?? candidate.text.normalize("NFKC").trim().toLocaleLowerCase("en")
    )
    valuesByKey.set(candidate.conflictKey, values)
  }
  const marked = ranked.map(({ candidate, relevance: score }) => ({
    ...candidate,
    relevance: score,
    conflict:
      candidate.conflictKey !== undefined && (valuesByKey.get(candidate.conflictKey)?.size ?? 0) > 1
  }))
  const selected: RankedRetrievalCandidate[] = []
  const selectedIds = new Set<string>()
  const counts = new Map<MemoryClass, number>()
  for (const candidate of marked) {
    if (selectedIds.has(candidate.id)) continue
    const group =
      candidate.conflict && candidate.conflictKey !== undefined
        ? marked
            .filter((item) => item.conflictKey === candidate.conflictKey)
            .sort(
              (left, right) =>
                Date.parse(left.occurredAt ?? left.validFrom ?? "") -
                  Date.parse(right.occurredAt ?? right.validFrom ?? "") ||
                left.id.localeCompare(right.id)
            )
        : [candidate]
    const groupCounts = new Map<MemoryClass, number>()
    for (const item of group) {
      groupCounts.set(item.memoryClass, (groupCounts.get(item.memoryClass) ?? 0) + 1)
    }
    if (
      [...groupCounts].some(
        ([memoryClass, count]) => (counts.get(memoryClass) ?? 0) + count > perMemoryClass
      )
    ) {
      continue
    }
    if (group.length > limit || selected.length + group.length > limit) continue
    for (const item of group) {
      selected.push(item)
      selectedIds.add(item.id)
      counts.set(item.memoryClass, (counts.get(item.memoryClass) ?? 0) + 1)
    }
    if (selected.length >= limit) break
  }
  return selected
}

export function boundRetrievalReading(
  candidates: readonly RankedRetrievalCandidate[],
  options: { readonly totalCharacters: number; readonly itemCharacters: number }
): readonly RankedRetrievalCandidate[] {
  const selected: RankedRetrievalCandidate[] = []
  const visitedConflictKeys = new Set<string>()
  let remaining = options.totalCharacters
  for (const candidate of candidates) {
    if (remaining <= 0) break
    if (candidate.conflictKey !== undefined && visitedConflictKeys.has(candidate.conflictKey)) {
      continue
    }
    const group =
      candidate.conflict && candidate.conflictKey !== undefined
        ? candidates.filter((item) => item.conflictKey === candidate.conflictKey)
        : [candidate]
    if (candidate.conflictKey !== undefined) visitedConflictKeys.add(candidate.conflictKey)
    const groupCharacters =
      group.reduce((sum, item) => sum + item.text.length, 0) + Math.max(0, group.length - 1)
    if (groupCharacters > options.itemCharacters || groupCharacters > remaining) continue
    selected.push(...group)
    remaining -= groupCharacters
  }
  return Object.freeze(selected)
}
