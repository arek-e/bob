import type { CapabilityCatalogue } from "@bob/capabilities-types/tools"

import type { TelemetryFeature, TelemetrySpanCode } from "./events.ts"

export function featureForToolName(
  catalogue: CapabilityCatalogue,
  toolName: string
): TelemetryFeature {
  return catalogue.moduleFor(toolName)?.feature ?? "assistant"
}

export function featureForTools(
  catalogue: CapabilityCatalogue,
  toolNames: readonly string[]
): TelemetryFeature {
  const features = new Set<TelemetryFeature>()
  for (const toolName of toolNames) {
    const feature = featureForToolName(catalogue, toolName)
    if (feature !== "assistant") features.add(feature)
  }
  if (features.size === 0) return "assistant"
  if (features.size === new Set(catalogue.modules.map((module) => module.feature)).size) {
    return "assistant"
  }
  if (features.size > 1) return "mixed"
  return [...features][0] ?? "assistant"
}

export function agentRunSpanCode(
  status: "completed" | "failed" | "cancelled",
  errorCode?: string
): TelemetrySpanCode | undefined {
  if (status === "completed") return undefined
  switch (errorCode) {
    case "authentication":
    case "quota":
    case "timeout":
    case "cancelled":
    case "provider":
    case "policy":
    case "invalid_output":
      return errorCode
    default:
      return status === "cancelled" ? "cancelled" : "unknown"
  }
}

export type TokenBudgetState = "within" | "warning" | "exceeded"

export function tokenBudgetState(consumedTokens: number, budgetTokens: number): TokenBudgetState {
  if (!Number.isSafeInteger(consumedTokens) || consumedTokens < 0) {
    throw new TypeError("Consumed tokens must be a non-negative integer")
  }
  if (!Number.isSafeInteger(budgetTokens) || budgetTokens < 1) {
    throw new TypeError("Budget tokens must be a positive integer")
  }
  if (consumedTokens >= budgetTokens) return "exceeded"
  return consumedTokens >= Math.ceil(budgetTokens * 0.8) ? "warning" : "within"
}
