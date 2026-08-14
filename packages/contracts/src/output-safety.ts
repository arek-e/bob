import { Schema } from "effect"

import { ToolName } from "./tools.ts"

export const OutputValidationCode = Schema.Literals([
  "response_envelope_too_long",
  "malformed_response",
  "response_too_long",
  "prompt_injection_echo",
  "secret_like_output",
  "source_required",
  "invalid_source_reference",
  "invalid_tool_reference",
  "unverified_action_claim",
  "unknown_action_claim",
  "unsupported_conflict",
  "conflict_not_disclosed"
])

export type OutputValidationCode = typeof OutputValidationCode.Type

const promptInjectionEchoes = [
  /\b(?:ignore|disregard|override|forget)\s+(?:all\s+)?(?:previous|prior|above|earlier)\s+(?:instructions?|rules?|messages?)\b/iu,
  /\b(?:reveal|print|repeat|show)\s+(?:the\s+)?(?:system|developer)\s+prompt\b/iu,
  /\b(?:new|updated)\s+(?:system|developer)\s+(?:prompt|instructions?)\b/iu,
  /\b(?:follow|obey|execute)\s+(?:these|the following)\s+instructions?\b/iu,
  /(?<![\p{L}\p{N}_])(?:ignorera|åsidosätt|glöm)\s+(?:alla\s+)?(?:tidigare|föregående|ovanstående)\s+(?:instruktioner|regler|meddelanden)(?![\p{L}\p{N}_])/iu,
  /(?<![\p{L}\p{N}_])(?:avslöja|visa|upprepa|skriv\s+ut)\s+(?:den\s+)?(?:system|utvecklar)\s*(?:prompt(?:en)?|instruktion(?:en|erna)?)(?![\p{L}\p{N}_])/iu,
  /(?<![\p{L}\p{N}_])(?:ny|nya|uppdaterad|uppdaterade)\s+(?:system|utvecklar)\s*(?:prompt(?:en|er)?|instruktion(?:en|er|erna)?)(?![\p{L}\p{N}_])/iu,
  /(?<![\p{L}\p{N}_])(?:följ|lyd|kör|verkställ)\s+(?:dessa|de\s+här|följande)\s+instruktion(?:er|erna)?(?![\p{L}\p{N}_])/iu,
  /\baccess[_ ]granted\b/iu,
  /åtkomst[_ ](?:beviljad|godkänd)/iu,
  /(?:<|\[)\/?(?:system|developer)(?:>|\])/iu
]

const secretLikeValues = [
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/u,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/u,
  /\b(?:hvs|ya29)\.[A-Za-z0-9_-]{20,}\b/u,
  /\bAKIA[0-9A-Z]{16}\b/u,
  /\bAGE-SECRET-KEY-1[A-Z0-9]{20,}\b/u,
  /\bBearer\s+[A-Za-z0-9._~+/-]{16,}\b/iu,
  /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/u,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/u,
  /\b(?:api[ _-]?key|access[ _-]?token|client[ _-]?secret|password|token|secret)\s*[:=]\s*["']?[A-Za-z0-9._~+/-]{8,}/iu,
  /(?:^|[\s([{])(?:api[ _-]?nyckel|åtkomst[ _-]?(?:token|nyckel)|klient[ _-]?hemlighet|lösenord|hemlighet)\s*(?::|=|är)\s*["']?[A-Za-z0-9._~+/-]{8,}/iu,
  /\b[0-9a-f]{32,64}\b/iu
]

export type UnsafeOutputCode = "prompt_injection_echo" | "secret_like_output"

function normalizeUserText(text: string): string {
  return text.normalize("NFKC").trim().replace(/\s+/gu, " ")
}

const englishPersonalRecall =
  /\b(?:do you remember|what do you know about me|what (?:did|do) i (?:say|tell|save|store|have)|what (?:is|are) (?:the )?(?:routine|plan|record|information) i (?:saved|stored)|what(?:'s| is| are) my|(?:what|which|when|where|who)\b(?:\s+\p{L}+){0,5}\s+my\b|when do i (?:train|work out|exercise)|(?:show|list) (?:me )?my|tell me (?:about )?my)\b/iu

const swedishPersonalRecall =
  /\b(?:kommer du ihåg|minns du|vad vet du om mig|vad (?:sa|berättade|har) jag|(?:vilken|vad) (?:tränings)?rutin (?:har jag )?(?:sparat|lagrat)|vad (?:är|har) (?:min|mitt|mina)|(?:vad|vilken|vilka|när|var)\b(?:\s+\p{L}+){0,5}\s+(?:min|mitt|mina)\b|när tränar jag|(?:visa|lista) (?:mig )?(?:min|mitt|mina)|påminn mig (?:om )?vad)\b/iu

/** Require citations only for a direct request to recall the owner's saved information. */
export function requiresPersonalGrounding(userText: string): boolean {
  const normalized = normalizeUserText(userText)
  return englishPersonalRecall.test(normalized) || swedishPersonalRecall.test(normalized)
}

/** This text is deterministic. It replaces an unsupported personal-recall answer. */
export function noSupportedRecordFallback(locale: string | undefined): string {
  return locale?.toLocaleLowerCase().startsWith("sv") === true
    ? "Jag har ingen uppgift med stöd för det."
    : "I do not have a supported record for that."
}

export function scanUnsafeOutput(text: string): UnsafeOutputCode | undefined {
  if (promptInjectionEchoes.some((pattern) => pattern.test(text))) {
    return "prompt_injection_echo"
  }
  if (secretLikeValues.some((pattern) => pattern.test(text))) return "secret_like_output"
  return undefined
}

export function internalToolReferences(text: string): readonly string[] {
  const registered = new Set<string>(ToolName.literals)
  return (text.match(/\b[a-z][a-z0-9]*_[a-z0-9_]+\b/giu) ?? []).filter((name) =>
    registered.has(name.toLowerCase())
  )
}
