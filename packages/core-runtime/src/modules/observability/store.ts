import type { TelemetryFeature } from "@bob/observability/events"

import { agentUsage } from "@bob/db/schema/observability"
import { tokenBudgetState } from "@bob/observability/attribution"
import { and, eq, gte, lt, sql } from "drizzle-orm"

import type { CoreDatabase } from "../../database.ts"

export const DEFAULT_RUN_TOKEN_BUDGET = 32_000
export const DEFAULT_DAILY_TOKEN_BUDGET = 250_000

export interface AgentUsageInput {
  readonly runId: string
  readonly ownerId: string
  readonly correlationId: string
  readonly feature: TelemetryFeature
  readonly provider: "openai-codex"
  readonly model: string
  readonly status: "completed" | "failed" | "cancelled"
  readonly inputTokens: number
  readonly outputTokens: number
  readonly toolCalls: number
  readonly durationMs: number
  readonly occurredAt: string
}

export interface UsageBudgetResult {
  readonly duplicate: boolean
  readonly run: {
    readonly consumedTokens: number
    readonly budgetTokens: number
    readonly state: ReturnType<typeof tokenBudgetState>
  }
  readonly utcDay: {
    readonly key: string
    readonly consumedTokens: number
    readonly budgetTokens: number
    readonly state: ReturnType<typeof tokenBudgetState>
  }
}

export interface UtcDayWindow {
  readonly key: string
  readonly start: string
  readonly end: string
}

export function utcDayWindow(occurredAt: string): UtcDayWindow {
  const instant = new Date(occurredAt)
  if (Number.isNaN(instant.getTime())) throw new TypeError("Usage time is invalid")
  const key = instant.toISOString().slice(0, 10)
  const start = `${key}T00:00:00.000Z`
  const end = new Date(new Date(start).getTime() + 86_400_000).toISOString()
  return { key, start, end }
}

function assertCount(value: number, label: string) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${label} must be a non-negative integer`)
  }
}

export async function recordAgentUsage(
  database: CoreDatabase,
  input: AgentUsageInput,
  budgets: {
    readonly runTokens?: number
    readonly dailyTokens?: number
  } = {}
): Promise<UsageBudgetResult> {
  assertCount(input.inputTokens, "Input tokens")
  assertCount(input.outputTokens, "Output tokens")
  assertCount(input.toolCalls, "Tool calls")
  assertCount(input.durationMs, "Duration")
  const runBudget = budgets.runTokens ?? DEFAULT_RUN_TOKEN_BUDGET
  const dailyBudget = budgets.dailyTokens ?? DEFAULT_DAILY_TOKEN_BUDGET
  const runTokens = input.inputTokens + input.outputTokens
  const window = utcDayWindow(input.occurredAt)
  const inserted = await database
    .insert(agentUsage)
    .values({
      runId: input.runId,
      userId: input.ownerId,
      correlationId: input.correlationId,
      feature: input.feature,
      workflow: "agent_turn",
      provider: input.provider,
      model: input.model,
      status: input.status,
      inputTokens: input.inputTokens,
      outputTokens: input.outputTokens,
      toolCalls: input.toolCalls,
      durationMs: input.durationMs,
      occurredAt: new Date(input.occurredAt).toISOString()
    })
    .onConflictDoNothing({ target: agentUsage.runId })
    .returning({ runId: agentUsage.runId })
  const [total] = await database
    .select({
      tokens: sql<number>`coalesce(sum(${agentUsage.inputTokens} + ${agentUsage.outputTokens}), 0)`
    })
    .from(agentUsage)
    .where(
      and(
        eq(agentUsage.userId, input.ownerId),
        gte(agentUsage.occurredAt, window.start),
        lt(agentUsage.occurredAt, window.end)
      )
    )
  const dailyTokens = Number(total?.tokens ?? 0)
  return {
    duplicate: inserted.length === 0,
    run: {
      consumedTokens: runTokens,
      budgetTokens: runBudget,
      state: tokenBudgetState(runTokens, runBudget)
    },
    utcDay: {
      key: window.key,
      consumedTokens: dailyTokens,
      budgetTokens: dailyBudget,
      state: tokenBudgetState(dailyTokens, dailyBudget)
    }
  }
}
