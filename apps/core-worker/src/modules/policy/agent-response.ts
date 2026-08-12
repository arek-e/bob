import type { AgentRunRequest, AgentRunResult } from "@bob/contracts/agent"

import {
  internalToolReferences,
  noSupportedRecordFallback,
  requiresPersonalGrounding,
  scanUnsafeOutput
} from "@bob/contracts/output-safety"

import { degradedRecall } from "./degraded-recall.ts"

export interface AgentResponseDecision {
  readonly text: string
  readonly reasonCode:
    | "agent_reply"
    | "agent_boundary_fallback"
    | "agent_degraded_recall"
    | "agent_failure"
}

function requestRequiresPersonalGrounding(request: AgentRunRequest): boolean {
  const orderedTurnText = request.currentTurnMessages?.map((message) => message.text).join("\n")
  return requiresPersonalGrounding(orderedTurnText ?? request.userText)
}

function safeBoundaryText(text: string | undefined, maximum: number): string | undefined {
  if (
    text === undefined ||
    text.length === 0 ||
    text.length > maximum ||
    scanUnsafeOutput(text) !== undefined ||
    internalToolReferences(text).length > 0
  ) {
    return undefined
  }
  return text
}

function groundedBoundaryText(
  result: AgentRunResult,
  request: AgentRunRequest
): string | undefined {
  const text = safeBoundaryText(result.responseText, request.limits.maxResponseCharacters)
  if (text === undefined) return undefined
  if (result.sourceIds === undefined || result.conflict === undefined) return undefined
  if (new Set(result.sourceIds).size !== result.sourceIds.length) return undefined

  const approved = new Map(
    request.contextItems.flatMap((item) =>
      item.sources.map(
        (source) =>
          [source.sourceId, { label: source.sourceLabel, conflict: item.conflict }] as const
      )
    )
  )
  for (const source of result.trustedToolSources ?? []) {
    if (!approved.has(source.sourceId)) {
      approved.set(source.sourceId, { label: source.sourceLabel, conflict: false })
    }
  }
  if (requestRequiresPersonalGrounding(request) && result.sourceIds.length === 0) {
    return undefined
  }
  const selected = result.sourceIds.map((sourceId) => approved.get(sourceId))
  if (selected.some((source) => source === undefined)) return undefined
  const citesConflict = selected.some((source) => source?.conflict === true)
  if ((result.conflict === "disclosed") !== citesConflict) return undefined

  const labels = [
    ...new Set(selected.flatMap((source) => (source === undefined ? [] : [source.label])))
  ]
  const grounded =
    labels.length === 0
      ? text
      : `${text}\n${labels.length === 1 ? "Source" : "Sources"}: ${labels.join("; ")}`
  return safeBoundaryText(grounded, request.limits.maxResponseCharacters)
}

export function selectAgentResponse(
  result: AgentRunResult,
  request: AgentRunRequest
): AgentResponseDecision {
  if (result.status === "completed") {
    const grounded = groundedBoundaryText(result, request)
    if (grounded !== undefined) return { text: grounded, reasonCode: "agent_reply" }
    const usesLegacyResultContract = result.sourceIds === undefined && result.conflict === undefined
    if (
      usesLegacyResultContract &&
      result.toolCalls === 0 &&
      !requestRequiresPersonalGrounding(request)
    ) {
      const legacyText = safeBoundaryText(result.responseText, request.limits.maxResponseCharacters)
      if (legacyText !== undefined) {
        return { text: legacyText, reasonCode: "agent_boundary_fallback" }
      }
    }
    if (requestRequiresPersonalGrounding(request)) {
      return {
        text: noSupportedRecordFallback(request.locale),
        reasonCode: "agent_boundary_fallback"
      }
    }
  }
  const boundaryText = safeBoundaryText(result.responseText, request.limits.maxResponseCharacters)
  if (result.status !== "completed" && boundaryText !== undefined) {
    return { text: boundaryText, reasonCode: "agent_boundary_fallback" }
  }
  const degraded = degradedRecall({
    userText: request.userText,
    contextItems: request.contextItems,
    maxResponseCharacters: request.limits.maxResponseCharacters
  })
  if (degraded !== undefined) {
    return { text: degraded, reasonCode: "agent_degraded_recall" }
  }
  return {
    text: "I could not complete that request. Please try again in Bob.",
    reasonCode: "agent_failure"
  }
}
