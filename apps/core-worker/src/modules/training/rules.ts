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
    normalized.endsWith("?") ||
    /^(?:är|kan|kunde|skulle|ska|bör|borde|får|har|gör|gjorde|vill|tycker|vad|vilken|vilket|vilka|hur|varför)\b/u.test(
      normalized
    )
  ) {
    return false
  }
  if (
    /\b(?:do not|don't|dont|never)\s+(?:approve|confirm|save|use)\b/u.test(normalized) ||
    /\bnot\s+(?:approve|approved|confirm|confirmed|save|saved|use)\b/u.test(normalized) ||
    /\b(?:inte|aldrig|nej|ingen|inget|inga)\b/u.test(normalized)
  ) {
    return false
  }
  return (
    /\b(?:approve|confirm|save|use)\b.{0,48}\b(?:routine|workout plan)\b/u.test(normalized) ||
    /\b(?:routine|workout plan)\b.{0,48}\b(?:is approved|looks good|save it|use it)\b/u.test(
      normalized
    ) ||
    /\b(?:godkänn|godkänner|godkänna|bekräfta|bekräftar|spara|sparar|använd|använda|använder)\b.{0,48}\b(?:rutin|rutinen|träningsrutin|träningsrutinen|träningsplan|träningsplanen|träningsprogram|träningsprogrammet)\b/u.test(
      normalized
    ) ||
    /\b(?:rutin|rutinen|träningsrutin|träningsrutinen|träningsplan|träningsplanen|träningsprogram|träningsprogrammet)\b.{0,48}(?:är godkänd|ser bra ut|spara den|använd den)\b/u.test(
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
    ) ||
    /^(?:kan|kunde|skulle|bör|borde|ska|får|är|har|gör|gjorde|vill|tycker|vad|när|var|varför|hur|vem|vilken|vilket|vilka)\b/u.test(
      normalized
    )
  ) {
    return false
  }
  return !/\b(?:no|not|never|don't|dont|cannot|can't|cant|won't|wont|without|nej|inte|aldrig|ingen|inget|inga|utan)\b/u.test(
    normalized
  )
}

export function trainingSafetySignal(
  text: string
): "pain_or_injury" | "machine_confusion" | undefined {
  const normalized = text.trim().toLowerCase()
  const withoutNegatedConfusion = normalized
    .replace(/\b(?:not|never)\s+(?:at all\s+)?(?:confused|unsure)\b/gu, "")
    .replace(/\b(?:inte|aldrig)\s+(?:längre\s+)?(?:förvirrad|förvirrande|osäker)\b/gu, "")
    .replace(/\bvarken\s+(?:förvirrad|osäker)\s+eller\s+(?:förvirrad|osäker)\b/gu, "")
  if (
    /\b(?:confused|confusing|unsure)\b.{0,40}\b(?:machine|equipment)\b/u.test(
      withoutNegatedConfusion
    ) ||
    /\b(?:do not|don't|dont|cannot|can't)\s+understand\b.{0,40}\b(?:machine|equipment)\b/u.test(
      normalized
    ) ||
    /\b(?:förvirrad|förvirrande|osäker)\b.{0,60}\b(?:maskin(?:en|er|erna)?|utrustning(?:en)?|gymutrustning(?:en)?)\b/u.test(
      withoutNegatedConfusion
    ) ||
    /\b(?:maskin(?:en|er|erna)?|utrustning(?:en)?|gymutrustning(?:en)?)\b.{0,60}\b(?:förvirrad|förvirrande|osäker)\b/u.test(
      withoutNegatedConfusion
    ) ||
    /\b(?:förstår|begriper)\s+inte\b.{0,60}\b(?:maskin(?:en|er|erna)?|utrustning(?:en)?|gymutrustning(?:en)?)\b/u.test(
      normalized
    ) ||
    /\bvet\s+inte\s+hur\b.{0,80}\b(?:maskin(?:en|er|erna)?|utrustning(?:en)?|gymutrustning(?:en)?)\b/u.test(
      normalized
    ) ||
    /\bhur\s+(?:(?:ska|kan)\s+jag\s+)?(?:använda|använder\s+jag|fungerar|används)\b.{0,60}\b(?:maskin(?:en|er|erna)?|utrustning(?:en)?|gymutrustning(?:en)?)\b/u.test(
      normalized
    )
  ) {
    return "machine_confusion"
  }
  const withoutNegatedPain = normalized
    .replace(/\b(?:no|without)\s+(?:new\s+)?(?:pain|injury|injuries|hurt|hurting)\b/gu, "")
    .replace(/\b(?:not|never)\s+(?:in\s+)?(?:pain|injured|hurt|hurting)\b/gu, "")
    .replace(/\b(?:(?:does|do|did)\s+not|doesn't|doesnt|don't|dont|didn't|didnt)\s+hurt\b/gu, "")
    .replace(/\bno longer\s+(?:hurts|hurt|hurting)\b/gu, "")
    .replace(/\b(?:ingen|utan)\s+(?:ny\s+)?(?:smärta|smärtor|skada)\b/gu, "")
    .replace(/\binga\s+(?:nya\s+)?skador\b/gu, "")
    .replace(/\b(?:inte|aldrig)\s+(?:längre\s+)?(?:ont|skadad|skadat)\b/gu, "")
    .replace(/\b(?:gör|har)\s+(?:absolut\s+)?inte\s+(?:längre\s+)?ont\b/gu, "")
    .replace(/\b(?:skadade|skadar)\s+(?:mig\s+)?inte\b/gu, "")
    .replace(/\binte\s+skadat\b/gu, "")
  if (
    /\b(?:pain|painful|injury|injured|hurts|hurt|hurting|strained|sprained|smärta|smärtor|smärtsam|skada|skador|skadad|skadat|skadade|ont|värk|värker|sträckte|sträckt|stukade|stukat|stukning)\b/u.test(
      withoutNegatedPain
    )
  ) {
    return "pain_or_injury"
  }
  return undefined
}

const englishTrainingSafetyResponse =
  "Stop this exercise now. Do not increase the weight. Ask a qualified trainer or health professional for help."

const swedishTrainingSafetyResponse =
  "Avsluta övningen nu. Öka inte vikten. Be en kvalificerad tränare eller vårdpersonal om hjälp."

const swedishTrainingSafetyText =
  /\b(?:jag|mig|mitt|min|mina|knä|axel|smärta|smärtor|skada|skador|skadad|skadat|ont|värk|värker|sträckte|sträckt|stukade|stukat|stukning|förstår|begriper|osäker|förvirrad|förvirrande|maskin(?:en|er|erna)?|utrustning(?:en)?|gymutrustning(?:en)?)\b/u

export function trainingSafetyResponse(text: string): string | undefined {
  if (trainingSafetySignal(text) === undefined) return undefined
  return swedishTrainingSafetyText.test(text.trim().toLowerCase())
    ? swedishTrainingSafetyResponse
    : englishTrainingSafetyResponse
}
