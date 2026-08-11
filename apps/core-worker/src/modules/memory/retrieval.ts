export interface RetrievalCandidate {
  readonly id: string
  /** Stable Core-owned identifier for response source grounding. */
  readonly sourceId: string
  readonly sourceType: string
  readonly text: string
  readonly sourceLabel: string
  readonly occurredAt?: string
  readonly importance: number
  readonly lexicalPosition: number
}

/** Build a literal FTS5 query from untrusted user text. */
export function buildFtsQuery(text: string): string | undefined {
  const tokens = [
    ...new Set(
      (
        text
          .normalize("NFKC")
          .toLocaleLowerCase("en")
          .match(/[\p{L}\p{N}]+/gu) ?? []
      ).filter((token) => token.length >= 2 || /^\d+$/u.test(token))
    )
  ].slice(0, 12)
  if (tokens.length === 0) return undefined
  return tokens.map((token) => `"${token.replaceAll('"', '""')}"`).join(" OR ")
}

function recencyScore(candidate: RetrievalCandidate, nowMs: number): number {
  if (candidate.sourceType === "fact_revision") return 1
  if (candidate.occurredAt === undefined) return 0
  const occurredAt = Date.parse(candidate.occurredAt)
  if (!Number.isFinite(occurredAt)) return 0
  const ageDays = Math.max(0, (nowMs - occurredAt) / 86_400_000)
  return Math.exp((-Math.log(2) * ageDays) / 90)
}

/**
 * Rank lexical candidates with bounded recency and importance signals.
 *
 * Confirmed facts never lose rank because they are old. The diversity pass
 * prevents one source type from filling the complete result set.
 */
export function rankRetrievalCandidates(
  candidates: readonly RetrievalCandidate[],
  options: {
    readonly nowMs?: number
    readonly limit?: number
    readonly perSourceType?: number
  } = {}
): readonly RetrievalCandidate[] {
  const nowMs = options.nowMs ?? Date.now()
  const limit = options.limit ?? 12
  const perSourceType = options.perSourceType ?? 3
  const ranked = candidates
    .map((candidate) => ({
      candidate,
      score:
        0.65 / (candidate.lexicalPosition + 1) +
        0.2 * Math.max(0, Math.min(1, candidate.importance / 1_000)) +
        0.15 * recencyScore(candidate, nowMs)
    }))
    .sort(
      (left, right) =>
        right.score - left.score ||
        left.candidate.lexicalPosition - right.candidate.lexicalPosition ||
        left.candidate.id.localeCompare(right.candidate.id)
    )

  const selected: RetrievalCandidate[] = []
  const counts = new Map<string, number>()
  for (const { candidate } of ranked) {
    const count = counts.get(candidate.sourceType) ?? 0
    if (count >= perSourceType) continue
    counts.set(candidate.sourceType, count + 1)
    selected.push(candidate)
    if (selected.length >= limit) break
  }
  return selected
}
