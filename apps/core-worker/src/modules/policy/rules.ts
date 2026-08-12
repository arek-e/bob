export type DeterministicCommand =
  | "repeat"
  | "why"
  | "help"
  | "pause"
  | "undo"
  | "seen"
  | "done"
  | "journal"
  | "stop"
  | "start"
  | "cancel"

const deterministicCommands = new Set<DeterministicCommand>([
  "repeat",
  "why",
  "help",
  "pause",
  "undo",
  "seen",
  "done",
  "journal",
  "stop",
  "start",
  "cancel"
])

const deterministicCommandAliases = new Map<string, DeterministicCommand>([
  ["hjälp", "help"],
  ["hjalp", "help"],
  ["klar", "done"],
  ["klart", "done"],
  ["färdig", "done"],
  ["fardig", "done"],
  ["färdigt", "done"],
  ["fardigt", "done"],
  ["sett", "seen"],
  ["uppfattat", "seen"],
  ["dagbok", "journal"],
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
  if (deterministicCommands.has(normalized as DeterministicCommand)) {
    return normalized as DeterministicCommand
  }
  return deterministicCommandAliases.get(normalized)
}

export function isArtifactResendRequest(text: string): boolean {
  const normalized = text.trim()
  if (normalized.length === 0 || normalized.length > 100) return false
  return /^(?:(?:please\s+)?(?:send|show)\s+(?:(?:me\s+)?(?:the|that|my)\s+)?(?:plan|workout|artifact|it)\s+again|(?:skicka|visa)\s+(?:mig\s+)?(?:(?:planen|träningsplanen|passet|den|det)\s+)?igen)[.!?]?$/iu.test(
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
    ? "Jag kan hjälpa till med påminnelser, rutiner, träningspass, minnen och länkar till din privata dagbok. Skicka en begäran i taget."
    : "I can help with reminders, routines, workouts, recall, and private journal links. Send one request at a time."
}

export function canSendChannelText(sensitivity: "normal" | "private" | "high"): boolean {
  return sensitivity === "normal"
}
