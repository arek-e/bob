export type DeterministicCommand =
  | "repeat"
  | "why"
  | "help"
  | "pause"
  | "undo"
  | "stop"
  | "start"
  | "cancel"

const deterministicCommands = [
  "repeat",
  "why",
  "help",
  "pause",
  "undo",
  "stop",
  "start",
  "cancel"
] as const

const deterministicCommandAliases = new Map<string, DeterministicCommand>([
  ["hjälp", "help"],
  ["hjalp", "help"],
  ["upprepa", "repeat"],
  ["varför", "why"],
  ["varfor", "why"],
  ["paus", "pause"],
  ["pausa", "pause"],
  ["ångra", "undo"],
  ["angra", "undo"]
])

export function classifyDeterministicCommand(text: string): DeterministicCommand | undefined {
  const normalized = text.trim().toLowerCase()
  const command = deterministicCommands.find((candidate) => candidate === normalized)
  if (command !== undefined) return command
  return deterministicCommandAliases.get(normalized)
}

export function isArtifactResendRequest(text: string): boolean {
  const normalized = text.trim()
  if (normalized.length === 0 || normalized.length > 100) return false
  return /^(?:(?:please\s+)?(?:send|show)\s+(?:(?:me\s+)?(?:the|that|my)\s+)?(?:plan|artifact|it)\s+again|(?:skicka|visa)\s+(?:mig\s+)?(?:(?:planen|den|det)\s+)?igen)[.!?]?$/iu.test(
    normalized
  )
}

export function deterministicCommandLanguage(text: string): "en" | "sv" {
  return deterministicCommandAliases.has(text.trim().toLowerCase()) ? "sv" : "en"
}

export interface ReplyBinding {
  readonly id: string
  readonly command: string
  readonly targetType: string
  readonly targetId: string
  readonly expiresAt: string
}

export type ReplyResolution =
  | { readonly kind: "none" }
  | { readonly kind: "one"; readonly binding: ReplyBinding }
  | { readonly kind: "ambiguous"; readonly bindings: readonly ReplyBinding[] }

export function resolveShortReply(
  command: string,
  bindings: readonly ReplyBinding[],
  now: Date
): ReplyResolution {
  const eligible = bindings.filter(
    (binding) => binding.command === command && Date.parse(binding.expiresAt) > now.getTime()
  )
  if (eligible.length === 0) return { kind: "none" }
  if (eligible.length === 1) return { kind: "one", binding: eligible[0]! }
  return { kind: "ambiguous", bindings: eligible }
}

const englishUrgentPattern =
  /\b(?:suicide|kill myself|immediate danger|cannot breathe|can't breathe|chest pain)\b/i

const swedishUrgentPattern =
  /(?:\bsjälvmord(?:stankar|splaner)?\b|\bta livet av mig\b|\bdöda mig själv\b|\bskada mig själv\b|\bvill dö\b|\b(?:akut|omedelbar) fara\b|\bi fara\b|\bkan inte (?:få luft|andas)\b|\bfår ingen luft\b|\bsvårt att andas\b|\bhåller på att kvävas\b|\bbröstsmärt(?:a|or)\b|\bont i bröstet\b|\bbröstet gör ont\b)/iu

export function urgentSafetyResponse(text: string): string | undefined {
  if (swedishUrgentPattern.test(text)) {
    return "Om du är i omedelbar fara, ring 112 nu. Be någon i närheten att stanna hos dig. Bob kan inte ge akut hjälp."
  }
  if (!englishUrgentPattern.test(text)) return undefined
  return "If you are in immediate danger, call 112 now. Ask someone nearby to stay with you. Bob cannot provide emergency help."
}

export function fixedHelpText(language: "en" | "sv" = "en"): string {
  return language === "sv"
    ? "Jag kan hjälpa dig att planera, minnas inställningar och använda dina godkända verktyg. Berätta vad du behöver."
    : "I can help you plan, remember preferences, and use your approved tools. Tell me what you need."
}

export function canSendChannelText(sensitivity: "normal" | "private" | "high"): boolean {
  return sensitivity === "normal"
}
