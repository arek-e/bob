import type { AgentRunResult } from "@bob/agent-types/run"
import type { CoreDatabase } from "@bob/db-types"
import type { AlertStore } from "@bob/operations-types/alerts"

import { emitHealth, type Telemetry } from "@bob/observability"
import { Effect } from "effect"

import { recordAgentUsage, type AgentUsageInput, type UsageBudgetResult } from "./store.ts"

export function reportAgentUsage(
  database: CoreDatabase,
  alerts: (typeof AlertStore)["Service"],
  input: AgentUsageInput,
  budgets: {
    readonly runTokens: number
    readonly dailyTokens: number
  }
): Effect.Effect<UsageBudgetResult | undefined, never, Telemetry> {
  return Effect.gen(function* () {
    const usage = yield* Effect.tryPromise(() => recordAgentUsage(database, input, budgets))
    const common = {
      correlationId: input.correlationId,
      runId: input.runId,
      feature: input.feature,
      workflow: "agent_turn" as const
    }
    yield* emitHealth({
      type: "token_budget",
      ...common,
      window: "run",
      windowKey: "run",
      state: usage.run.state,
      consumedTokens: usage.run.consumedTokens,
      budgetTokens: usage.run.budgetTokens
    })
    yield* emitHealth({
      type: "token_budget",
      ...common,
      window: "utc_day",
      windowKey: usage.utcDay.key,
      state: usage.utcDay.state,
      consumedTokens: usage.utcDay.consumedTokens,
      budgetTokens: usage.utcDay.budgetTokens
    })
    if (usage.run.state === "exceeded") {
      yield* alerts.record({
        ownerId: input.ownerId,
        code: "token_budget_exceeded",
        objectType: "agent_run",
        objectId: input.runId,
        idempotencyKey: `alert:token-budget:run:${input.runId}`
      })
    }
    if (usage.utcDay.state === "exceeded") {
      yield* alerts.record({
        ownerId: input.ownerId,
        code: "token_budget_exceeded",
        objectType: "usage_utc_day",
        objectId: usage.utcDay.key,
        idempotencyKey: `alert:token-budget:utc-day:${input.ownerId}:${usage.utcDay.key}`
      })
    }
    return usage
  }).pipe(Effect.catch(() => Effect.succeed(undefined)))
}

export function reportAgentFailure(
  alerts: (typeof AlertStore)["Service"],
  ownerId: string,
  result: AgentRunResult
): Effect.Effect<void, unknown> {
  if (result.status !== "failed" || result.errorCode === undefined) return Effect.void
  if (result.errorCode === "authentication") {
    return alerts
      .record({
        ownerId,
        code: "agent_authentication_failed",
        objectType: "agent_run",
        objectId: result.runId,
        idempotencyKey: `alert:agent-authentication:${result.runId}`
      })
      .pipe(Effect.asVoid)
  }
  if (result.errorCode === "quota") {
    return alerts
      .record({
        ownerId,
        code: "agent_quota_exhausted",
        objectType: "agent_run",
        objectId: result.runId,
        idempotencyKey: `alert:agent-quota:${result.runId}`
      })
      .pipe(Effect.asVoid)
  }
  if (
    result.errorCode === "provider" ||
    result.errorCode === "timeout" ||
    result.errorCode === "invalid_output"
  ) {
    return alerts
      .record({
        ownerId,
        code: "agent_run_failed",
        objectType: "agent_run",
        objectId: result.runId,
        idempotencyKey: `alert:agent-run-failed:${result.runId}`
      })
      .pipe(Effect.asVoid)
  }
  return Effect.void
}
