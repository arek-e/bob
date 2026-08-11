export interface TrainingSafetyInput {
  readonly painReported: boolean
  readonly injuryReported: boolean
  readonly machineConfusion: boolean
}

export type TrainingSafetyDecision =
  | { readonly stop: false }
  | { readonly stop: true; readonly response: string; readonly code: string }

export function trainingSafetyDecision(input: TrainingSafetyInput): TrainingSafetyDecision {
  if (!input.painReported && !input.injuryReported && !input.machineConfusion)
    return { stop: false }
  return {
    stop: true,
    code: input.machineConfusion ? "machine_confusion" : "pain_or_injury",
    response:
      "Stop this exercise now. Do not increase the weight. Ask a qualified trainer or health professional for help."
  }
}

export function hasExplicitRoutineApproval(text: string): boolean {
  const normalized = text.trim().toLowerCase()
  if (
    /\b(?:do not|don't|dont|never)\s+(?:approve|confirm|save|use)\b/u.test(normalized) ||
    /\bnot\s+(?:approve|approved|confirm|confirmed|save|saved|use)\b/u.test(normalized)
  ) {
    return false
  }
  return (
    /\b(?:approve|confirm|save|use)\b.{0,48}\b(?:routine|workout plan)\b/u.test(normalized) ||
    /\b(?:routine|workout plan)\b.{0,48}\b(?:is approved|looks good|save it|use it)\b/u.test(
      normalized
    )
  )
}

export function isTrainingMutationRequest(text: string): boolean {
  const normalized = text.trim().toLowerCase()
  if (normalized.length === 0 || normalized.endsWith("?")) return false
  if (
    /^(?:can|could|would|should|do|does|did|is|are|am|may|might|will|what|when|where|why|how)\b/u.test(
      normalized
    )
  ) {
    return false
  }
  return !/\b(?:no|not|never|don't|dont|cannot|can't|cant|won't|wont|without)\b/u.test(normalized)
}

export function trainingSafetySignal(
  text: string
): "pain_or_injury" | "machine_confusion" | undefined {
  const normalized = text.trim().toLowerCase()
  if (
    /\b(?:confused|confusing|unsure)\b.{0,40}\b(?:machine|equipment)\b/u.test(normalized) ||
    /\b(?:do not|don't|dont|cannot|can't)\s+understand\b.{0,40}\b(?:machine|equipment)\b/u.test(
      normalized
    )
  ) {
    return "machine_confusion"
  }
  const withoutNegatedPain = normalized.replace(
    /\b(?:no|not|without)\s+(?:new\s+)?(?:pain|injury|injuries|hurt|hurting)\b/gu,
    ""
  )
  if (
    /\b(?:pain|painful|injury|injured|hurts|hurt|hurting|strained|sprained)\b/u.test(
      withoutNegatedPain
    )
  ) {
    return "pain_or_injury"
  }
  return undefined
}
