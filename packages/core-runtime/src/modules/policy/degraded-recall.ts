import type { ContextItem } from "@bob/contracts/agent"

import { internalToolReferences, scanUnsafeOutput } from "@bob/contracts/output-safety"

export interface DegradedRecallInput {
  readonly userText: string
  readonly contextItems: readonly ContextItem[]
  readonly maxResponseCharacters: number
}

const mutationVerb =
  "(?:create|add|save|set|update|change|start|finish|log|cancel|complete|mark|delete|remove|record|correct|propose|make)"
const mutationPatterns = [
  new RegExp(`^\\s*(?:please\\s+)?${mutationVerb}\\b`, "iu"),
  new RegExp(`^\\s*(?:can|could|would|will)\\s+you\\s+${mutationVerb}\\b`, "iu"),
  /^\s*(?:can|could|would|will)\s+you\s+(?!(?:show|list|tell|recall|repeat)\b)/iu,
  new RegExp(`^\\s*i\\s+(?:want|need)\\s+(?:you\\s+to\\s+|to\\s+)?${mutationVerb}\\b`, "iu")
]

function containsUnsafeRecall(value: string): boolean {
  return scanUnsafeOutput(value) !== undefined || internalToolReferences(value).length > 0
}

function isRecallQuestion(text: string): boolean {
  return (
    text.includes("?") ||
    /^\s*(?:what|when|where|which|who|how|show|list|tell me|recall|repeat|do i|did i|is my|are my|have i)\b/iu.test(
      text
    )
  )
}

function isMutationRequest(text: string): boolean {
  return mutationPatterns.some((pattern) => pattern.test(text))
}

function withinLimit(text: string, maximum: number): string | undefined {
  return text.length <= maximum ? text : undefined
}

export function degradedRecall(input: DegradedRecallInput): string | undefined {
  if (!isRecallQuestion(input.userText) || isMutationRequest(input.userText)) return undefined
  const candidates = input.contextItems.filter(
    (candidate) => candidate.instruction === false && candidate.sources.length > 0
  )
  const conflicts = candidates.filter((candidate) => candidate.conflict)
  if (conflicts.length > 0) {
    return withinLimit(
      "I found conflicting saved information. I cannot tell which record is current.",
      input.maxResponseCharacters
    )
  }
  if (candidates.length > 1) {
    return withinLimit(
      `I found ${candidates.length} saved records. Open Bob to choose the correct one.`,
      input.maxResponseCharacters
    )
  }
  const item = candidates[0]
  if (item === undefined) return undefined
  const sourceLabel = item.sources[0]?.sourceLabel
  if (sourceLabel === undefined) return undefined
  if (containsUnsafeRecall(item.text) || containsUnsafeRecall(sourceLabel)) {
    return withinLimit(
      "I found saved information, but I could not safely show it. Open Bob to review it.",
      input.maxResponseCharacters
    )
  }
  return withinLimit(
    `I could not use the assistant. From your saved records: ${item.text}`,
    input.maxResponseCharacters
  )
}
