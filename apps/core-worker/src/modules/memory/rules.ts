export type OriginClass =
  | "owner_input"
  | "system_record"
  | "recalled_content"
  | "tool_output"
  | "assistant_output"
  | "background_model"

export interface MemoryCandidateInput {
  readonly assertionKind: "user_stated" | "system_recorded" | "inferred"
  readonly originClass: OriginClass
  readonly sensitive: boolean
  readonly highImpact: boolean
  readonly explicitRemember: boolean
  readonly conflictsWithConfirmed: boolean
}

export type CandidateDecision = "proposed" | "disputed" | "confirmed"

export function decideCandidate(input: MemoryCandidateInput): CandidateDecision {
  if (input.conflictsWithConfirmed) return "disputed"
  const originCanConfirm =
    input.originClass === "owner_input" || input.originClass === "system_record"
  const systemCanConfirm =
    input.originClass !== "system_record" || input.assertionKind === "system_recorded"
  if (
    input.explicitRemember &&
    originCanConfirm &&
    systemCanConfirm &&
    input.assertionKind !== "inferred" &&
    !input.sensitive &&
    !input.highImpact
  ) {
    return "confirmed"
  }
  return "proposed"
}

export interface RankedMemory {
  readonly id: string
  readonly relevance: number
  readonly importance: number
  readonly occurredAt?: string
  readonly stableProfile: boolean
}

export function rankMemories(items: readonly RankedMemory[], now: Date): readonly RankedMemory[] {
  return [...items].sort((left, right) => score(right, now) - score(left, now))
}

function score(item: RankedMemory, now: Date): number {
  const ageDays = item.occurredAt
    ? Math.max(0, (now.getTime() - Date.parse(item.occurredAt)) / 86_400_000)
    : 0
  const recency = item.stableProfile ? 1 : Math.exp(-ageDays / 90)
  return item.relevance * 0.6 + item.importance * 0.3 + recency * 0.1
}

export function canPromoteOrigin(origin: OriginClass): boolean {
  return origin === "owner_input" || origin === "system_record"
}

export interface DerivedMemoryPolicy {
  readonly sensitivity: "normal" | "private" | "high"
  readonly modelEligible: boolean
  readonly channelEligible: boolean
}

export function deriveMemoryPolicy(input: {
  readonly authority: "agent" | "owner_deterministic" | "completed_system_command"
  readonly scope: string
  readonly originClass: OriginClass
}): DerivedMemoryPolicy {
  const highImpactScope =
    /\b(?:health|medical|medication|identity|location|address|finance|legal)\b/u.test(
      input.scope.toLowerCase()
    )
  if (highImpactScope) {
    return { sensitivity: "high", modelEligible: false, channelEligible: false }
  }
  if (input.authority === "agent") {
    return { sensitivity: "private", modelEligible: false, channelEligible: false }
  }
  const eligible =
    input.authority === "completed_system_command" && input.originClass === "system_record"
  return {
    sensitivity: eligible ? "normal" : "private",
    modelEligible: eligible,
    channelEligible: eligible
  }
}

export function deriveConfirmedMemoryPolicy(input: {
  readonly sensitivity: "normal" | "private" | "high"
  readonly disclosure: "model_and_channel" | "private"
}): DerivedMemoryPolicy {
  if (input.sensitivity === "high") {
    return { sensitivity: "high", modelEligible: false, channelEligible: false }
  }
  const eligible = input.sensitivity === "normal" && input.disclosure === "model_and_channel"
  return {
    sensitivity: eligible ? "normal" : input.sensitivity,
    modelEligible: eligible,
    channelEligible: eligible
  }
}
