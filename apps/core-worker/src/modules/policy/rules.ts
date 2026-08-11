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

export function classifyDeterministicCommand(text: string): DeterministicCommand | undefined {
  const normalized = text.trim().toLowerCase()
  return deterministicCommands.has(normalized as DeterministicCommand)
    ? (normalized as DeterministicCommand)
    : undefined
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

const urgentPattern =
  /\b(?:suicide|kill myself|immediate danger|cannot breathe|can't breathe|chest pain)\b/i

export function urgentSafetyResponse(text: string): string | undefined {
  if (!urgentPattern.test(text)) return undefined
  return "If you are in immediate danger, call 112 now. Ask someone nearby to stay with you. Bob cannot provide emergency help."
}

export function fixedHelpText(): string {
  return "I can help with reminders, routines, workouts, recall, and private journal links. Send one request at a time."
}

export function canSendChannelText(sensitivity: "normal" | "private" | "high"): boolean {
  return sensitivity === "normal"
}
