import type { AgentRunResult } from "@bob/contracts/agent"

import { observeHealth, type EventSink } from "@bob/observability/events"

import type { CoreDatabase } from "../../database.ts"
import type { AlertStore } from "../alerts/store.ts"

import { recordAgentUsage, type AgentUsageInput, type UsageBudgetResult } from "./store.ts"

export async function reportAgentUsage(
  database: CoreDatabase,
  alerts: AlertStore,
  events: EventSink,
  input: AgentUsageInput,
  budgets: {
    readonly runTokens: number
    readonly dailyTokens: number
  }
): Promise<UsageBudgetResult | undefined> {
  try {
    const usage = await recordAgentUsage(database, input, budgets)
    const common = {
      correlationId: input.correlationId,
      runId: input.runId,
      feature: input.feature,
      workflow: "agent_turn" as const
    }
    await observeHealth(events, {
      type: "token_budget",
      ...common,
      window: "run",
      windowKey: "run",
      state: usage.run.state,
      consumedTokens: usage.run.consumedTokens,
      budgetTokens: usage.run.budgetTokens
    })
    await observeHealth(events, {
      type: "token_budget",
      ...common,
      window: "utc_day",
      windowKey: usage.utcDay.key,
      state: usage.utcDay.state,
      consumedTokens: usage.utcDay.consumedTokens,
      budgetTokens: usage.utcDay.budgetTokens
    })
    if (usage.run.state === "exceeded") {
      await alerts.record({
        ownerId: input.ownerId,
        code: "token_budget_exceeded",
        objectType: "agent_run",
        objectId: input.runId,
        idempotencyKey: `alert:token-budget:run:${input.runId}`
      })
    }
    if (usage.utcDay.state === "exceeded") {
      await alerts.record({
        ownerId: input.ownerId,
        code: "token_budget_exceeded",
        objectType: "usage_utc_day",
        objectId: usage.utcDay.key,
        idempotencyKey: `alert:token-budget:utc-day:${input.ownerId}:${usage.utcDay.key}`
      })
    }
    return usage
  } catch {
    return undefined
  }
}

export async function reportAgentFailure(
  alerts: AlertStore,
  ownerId: string,
  result: AgentRunResult
): Promise<void> {
  if (result.status !== "failed" || result.errorCode === undefined) return
  if (result.errorCode === "authentication") {
    await alerts.record({
      ownerId,
      code: "agent_authentication_failed",
      objectType: "agent_run",
      objectId: result.runId,
      idempotencyKey: `alert:agent-authentication:${result.runId}`
    })
    return
  }
  if (result.errorCode === "quota") {
    await alerts.record({
      ownerId,
      code: "agent_quota_exhausted",
      objectType: "agent_run",
      objectId: result.runId,
      idempotencyKey: `alert:agent-quota:${result.runId}`
    })
    return
  }
  if (
    result.errorCode === "provider" ||
    result.errorCode === "timeout" ||
    result.errorCode === "invalid_output"
  ) {
    await alerts.record({
      ownerId,
      code: "agent_run_failed",
      objectType: "agent_run",
      objectId: result.runId,
      idempotencyKey: `alert:agent-run-failed:${result.runId}`
    })
  }
}
