import type { ContextItem } from "@bob/contracts/agent"

import { internalToolReferences, scanUnsafeOutput } from "@bob/contracts/output-safety"

export interface DegradedRecallInput {
  readonly userText: string
  readonly contextItems: readonly ContextItem[]
  readonly maxResponseCharacters: number
}

const mutationVerb =
  "(?:create|add|save|set|update|change|start|finish|log|cancel|snooze|complete|mark|delete|remove|remind|acknowledge|map|record|correct|propose|make)"
const mutationPatterns = [
  new RegExp(`^\\s*(?:please\\s+)?${mutationVerb}\\b`, "iu"),
  new RegExp(`^\\s*(?:can|could|would|will)\\s+you\\s+${mutationVerb}\\b`, "iu"),
  new RegExp(`^\\s*i\\s+(?:want|need)\\s+(?:you\\s+to\\s+|to\\s+)?${mutationVerb}\\b`, "iu")
]

function containsUnsafeRecall(value: string): boolean {
  return scanUnsafeOutput(value) !== undefined || internalToolReferences(value).length > 0
}

function relevantKinds(text: string): ReadonlySet<ContextItem["kind"]> {
  if (/\bgym|routine|workout|exercise|training|sets?\b/iu.test(text)) {
    return new Set(["training"])
  }
  if (/\bremind(?:er|ers|ing)?|snooze|due\b/iu.test(text)) {
    return new Set(["reminder"])
  }
  return new Set(["profile", "fact", "conversation"])
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
  const kinds = relevantKinds(input.userText)
  const candidates = input.contextItems.filter(
    (candidate) =>
      candidate.instruction === false && candidate.sources.length > 0 && kinds.has(candidate.kind)
  )
  const conflicts = candidates.filter((candidate) => candidate.conflict)
  if (conflicts.length > 0) {
    const labels = [
      ...new Set(
        conflicts
          .flatMap((item) => item.sources.map((source) => source.sourceLabel))
          .filter((label) => !containsUnsafeRecall(label))
          .slice(0, 3)
      )
    ]
    const joined =
      labels.length <= 1
        ? labels[0]
        : `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}`
    return withinLimit(
      `I found conflicting saved information${joined === undefined ? "" : ` from ${joined}`}. I cannot tell which record is current.`,
      input.maxResponseCharacters
    )
  }
  if (candidates.length > 1) {
    const recordType = candidates.every((item) => item.kind === "reminder")
      ? "saved reminders"
      : candidates.every((item) => item.kind === "training")
        ? "saved training records"
        : "saved records"
    return withinLimit(
      `I found ${candidates.length} ${recordType}. Open Bob to choose the correct one.`,
      input.maxResponseCharacters
    )
  }
  const item = candidates[0]
  if (item === undefined) return undefined
  const sourceLabel = item.sources[0]?.sourceLabel
  if (sourceLabel === undefined) return undefined
  if (containsUnsafeRecall(item.text) || containsUnsafeRecall(sourceLabel)) {
    return withinLimit(
      `I found saved information, but I could not safely show it.${containsUnsafeRecall(sourceLabel) ? "" : ` Open Bob to review ${sourceLabel}.`}`,
      input.maxResponseCharacters
    )
  }
  return withinLimit(
    `I could not use the assistant. From your saved records: ${item.text} [${sourceLabel}]`,
    input.maxResponseCharacters
  )
}
