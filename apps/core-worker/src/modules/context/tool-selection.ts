import type { ToolName } from "@bob/contracts/tools"

function hasExplicitMemoryOptOut(text: string): boolean {
  const normalized = text.trim().toLowerCase()
  return (
    /\b(?:do not|don't|dont|never)\s+(?:remember|save|store)\b/u.test(normalized) ||
    /\b(?:remember|save|store)\s+not\b/u.test(normalized) ||
    /\b(?:kom\s+inte\s+ihåg|spara\s+inte|lagra\s+inte|glöm)\b/u.test(normalized) ||
    /\bjag\s+vill\s+inte\s+att\s+du\s+(?:kommer\s+ihåg|sparar|lagrar)\b/u.test(normalized)
  )
}

function hasExplicitMemoryProposalRequest(text: string): boolean {
  const normalized = text.trim().toLowerCase()
  if (hasExplicitMemoryOptOut(text)) return false
  if (/^(?:please\s+)?remember\s+to\b/u.test(normalized)) return false
  return (
    /^(?:please\s+)?(?:remember|save|store)\b/u.test(normalized) ||
    /^(?:can|could|would)\s+you\s+(?:please\s+)?(?:remember|save|store)\b/u.test(normalized) ||
    /^i\s+(?:want|need)\s+you\s+to\s+(?:remember|save|store)\b/u.test(normalized) ||
    /^(?:snälla\s+)?(?:kom\s+ihåg|spara|lagra|lägg\s+.+\s+på\s+minnet)\b/u.test(normalized) ||
    /^(?:kan|kunde|skulle)\s+du\s+(?:snälla\s+)?(?:komma\s+ihåg|spara|lagra)\b/u.test(normalized) ||
    /^jag\s+(?:vill|behöver)\s+att\s+du\s+(?:kommer\s+ihåg|sparar|lagrar)\b/u.test(normalized)
  )
}

function hasExplicitDomainSaveRequest(text: string): boolean {
  const normalized = text.trim().toLowerCase()
  return (
    /^(?:please\s+)?(?:save|store)\b.*\b(?:routine|workout|exercise|gym|journal|reminder)\b/u.test(
      normalized
    ) ||
    /^(?:snälla\s+)?(?:spara|lagra)\b.*\b(?:rutin|träningspass|övning|gym|dagbok|påminnelse)\b/u.test(
      normalized
    )
  )
}

const memoryProposalTools = ["memory_search", "memory_propose", "memory_correct"] as const
const memoryReadTools = ["memory_search", "memory_correct"] as const

function shouldOfferMemoryProposal(text: string): boolean {
  const normalized = text.trim().toLowerCase()
  return (
    !hasExplicitMemoryOptOut(text) &&
    !hasExplicitDomainSaveRequest(text) &&
    !/^(?:please\s+)?remember\s+to\b/u.test(normalized)
  )
}

export function selectTools(text: string): readonly ToolName[] {
  const normalized = text.toLowerCase()
  const memoryProposalRequest = hasExplicitMemoryProposalRequest(text)
  if (memoryProposalRequest && !hasExplicitDomainSaveRequest(text)) return memoryProposalTools
  const includeMemoryProposal = (tools: readonly ToolName[]): readonly ToolName[] =>
    shouldOfferMemoryProposal(text) ? [...new Set([...tools, ...memoryProposalTools])] : tools
  if (
    /\b(?:calendar|google\s+calendar|outlook|microsoft\s+calendar|connect(?:ion)?|link(?:ed|ing)?)\b|\b(?:kalender(?:n)?|anslut(?:a|ning)?|koppla)\b/u.test(
      normalized
    )
  ) {
    return includeMemoryProposal(["connection_list", "connection_link_create"])
  }
  if (
    /\bsettings?\b|\bpreferences?\b|\blocality\b|\btime\s*zone\b|\btimezone\b|\blocale\b|\blanguage\b|\bregion\b|\btime\s*format\b|\b12[- ]hour\b|\b24[- ]hour\b|\binställning(?:en|ar|arna)?\b|\bpreferenser?\b|\btidszon(?:en)?\b|\bspråk(?:et)?\b|\b(?:svenska|engelska)\b|\btidsformat(?:et)?\b|\b(?:12|24)[- ]?timmars(?:format)?\b/u.test(
      normalized
    )
  ) {
    return includeMemoryProposal(["settings_get", "settings_update"])
  }
  if (
    /\bremind|reminder|snooze\b|\bpåminn|\bsnooza\b|\bsenarelägg\b|\bskjut(?:a)?\s+upp\b/u.test(
      normalized
    )
  ) {
    return includeMemoryProposal([
      "reminder_create",
      "reminder_list",
      "reminder_acknowledge",
      "reminder_complete",
      "reminder_snooze",
      "reminder_cancel"
    ])
  }
  if (/\b(?:journal|dagbok(?:en)?)\b/u.test(normalized)) {
    return includeMemoryProposal(["journal_link_create", "journal_search_metadata"])
  }
  if (
    /\b(?:(?:gym|routine|workout|exercise|machine|set)s?|equipment)\b|\brutin(?:en)?\b|\btränings(?:rutin(?:en)?|pass(?:et)?|plan(?:en)?|program(?:met)?)\b|(?<![\p{L}\p{N}_])övning(?:en|ar|arna)?(?![\p{L}\p{N}_])|\bmaskin(?:en|er|erna)?\b|\butrustning(?:en)?\b/u.test(
      normalized
    )
  ) {
    return includeMemoryProposal([
      "gym_list",
      "gym_create",
      "equipment_list",
      "exercise_create",
      "exercise_list",
      "gym_add_equipment",
      "equipment_map_exercise",
      "routine_save",
      "routine_get",
      "workout_start",
      "workout_log_set",
      "workout_finish",
      "workout_last",
      "workout_history"
    ])
  }
  return shouldOfferMemoryProposal(text) ? memoryProposalTools : memoryReadTools
}

function isShortListFollowUp(text: string): boolean {
  const normalized = text
    .trim()
    .toLowerCase()
    .replace(/[.!?]+$/gu, "")
    .trim()
  return /^(?:please\s+)?(?:list(?:\s+them)?|show(?:\s+(?:me|them))?|lista|visa(?:\s+dem)?)$/u.test(
    normalized
  )
}

export function selectToolsWithPriorCapabilities(
  text: string,
  priorCapabilities: readonly ToolName[]
): readonly ToolName[] {
  const selected = new Set(selectTools(text))
  if (isShortListFollowUp(text) && priorCapabilities.includes("reminder_list")) {
    selected.add("reminder_list")
  }
  return [...selected]
}
