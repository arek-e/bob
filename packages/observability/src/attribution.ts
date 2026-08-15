import { capabilityForToolName, ToolName } from "@bob/contracts/tools"
import { Schema } from "effect"

import type { TelemetryFeature, TelemetrySpanCode } from "./events.ts"

const featureOrder: readonly TelemetryFeature[] = [
  "reminders",
  "memory",
  "journal",
  "training",
  "settings"
]

export function featureForToolName(toolName: string): TelemetryFeature {
  const name = Schema.decodeUnknownOption(ToolName)(toolName)
  return name._tag === "None" ? "assistant" : capabilityForToolName(name.value).feature
}

export function featureForTools(toolNames: readonly string[]): TelemetryFeature {
  const features = new Set<TelemetryFeature>()
  for (const toolName of toolNames) {
    const feature = featureForToolName(toolName)
    if (feature !== "assistant") features.add(feature)
  }
  if (features.size === 0) return "assistant"
  if (features.size === featureOrder.length) return "assistant"
  if (features.size > 1) return "mixed"
  return featureOrder.find((feature) => features.has(feature)) ?? "assistant"
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
