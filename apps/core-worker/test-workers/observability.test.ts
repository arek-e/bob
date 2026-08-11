import { captureEvents } from "@bob/observability/testing"
import { applyD1Migrations, reset } from "cloudflare:test"
import { env } from "cloudflare:workers"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { createCoreDatabase } from "../src/database.ts"
import { operationalAlerts } from "../src/modules/alerts/schema.ts"
import { makeAlertStore } from "../src/modules/alerts/store.ts"
import { reportAgentFailure, reportAgentUsage } from "../src/modules/observability/reporting.ts"
import { agentUsage } from "../src/modules/observability/schema.ts"
import { recordAgentUsage, utcDayWindow } from "../src/modules/observability/store.ts"
import { decodeTestMigrations } from "./migrations.ts"

declare global {
  namespace Cloudflare {
    interface Env {
      DB: D1Database
      TEST_MIGRATIONS: string
    }
  }
}

const ownerId = "00000000-0000-4000-8000-000000000001"
const correlationId = "00000000-0000-4000-8000-000000000002"

beforeEach(async () => {
  await applyD1Migrations(env.DB, decodeTestMigrations(env.TEST_MIGRATIONS))
})

afterEach(async () => {
  await reset()
})

describe("content-free agent usage", () => {
  it("uses stable UTC-day boundaries", () => {
    expect(utcDayWindow("2026-08-11T23:59:59.000Z")).toEqual({
      key: "2026-08-11",
      start: "2026-08-11T00:00:00.000Z",
      end: "2026-08-12T00:00:00.000Z"
    })
  })

  it("attributes tokens once and returns run and daily budget states", async () => {
    const database = createCoreDatabase(env.DB)
    const input = {
      runId: "00000000-0000-4000-8000-000000000003",
      ownerId,
      correlationId,
      feature: "memory" as const,
      provider: "openai-codex" as const,
      model: "test-model",
      status: "completed" as const,
      inputTokens: 70,
      outputTokens: 10,
      toolCalls: 1,
      durationMs: 25,
      occurredAt: "2026-08-11T10:00:00.000Z"
    }
    await expect(
      recordAgentUsage(database, input, { runTokens: 100, dailyTokens: 100 })
    ).resolves.toMatchObject({
      duplicate: false,
      run: { consumedTokens: 80, state: "warning" },
      utcDay: { key: "2026-08-11", consumedTokens: 80, state: "warning" }
    })
    await expect(
      recordAgentUsage(database, input, { runTokens: 100, dailyTokens: 100 })
    ).resolves.toMatchObject({
      duplicate: true,
      utcDay: { consumedTokens: 80 }
    })
    expect(await database.select().from(agentUsage)).toEqual([
      expect.objectContaining({
        runId: input.runId,
        userId: ownerId,
        feature: "memory",
        inputTokens: 70,
        outputTokens: 10
      })
    ])
  })

  it("aggregates each feature into one owner daily budget", async () => {
    const database = createCoreDatabase(env.DB)
    const base = {
      ownerId,
      correlationId,
      provider: "openai-codex" as const,
      model: "test-model",
      status: "completed" as const,
      outputTokens: 10,
      toolCalls: 0,
      durationMs: 25,
      occurredAt: "2026-08-11T10:00:00.000Z"
    }
    await recordAgentUsage(
      database,
      {
        ...base,
        runId: "00000000-0000-4000-8000-000000000003",
        feature: "assistant",
        inputTokens: 30
      },
      { dailyTokens: 100 }
    )
    const result = await recordAgentUsage(
      database,
      {
        ...base,
        runId: "00000000-0000-4000-8000-000000000004",
        feature: "training",
        inputTokens: 50
      },
      { dailyTokens: 100 }
    )
    expect(result.utcDay).toMatchObject({ consumedTokens: 100, state: "exceeded" })
  })

  it("creates one content-free alert when the daily budget is exceeded", async () => {
    const database = createCoreDatabase(env.DB)
    const alerts = makeAlertStore(database, {
      now: () => new Date("2026-08-11T12:00:00.000Z"),
      randomUuid: () => "00000000-0000-4000-8000-000000000099"
    })
    const events = captureEvents()
    const base = {
      ownerId,
      correlationId,
      provider: "openai-codex" as const,
      model: "test-model",
      status: "completed" as const,
      outputTokens: 10,
      toolCalls: 0,
      durationMs: 25,
      occurredAt: "2026-08-11T10:00:00.000Z"
    }
    await reportAgentUsage(
      database,
      alerts,
      events,
      {
        ...base,
        runId: "00000000-0000-4000-8000-000000000003",
        feature: "assistant",
        inputTokens: 70
      },
      { runTokens: 1_000, dailyTokens: 100 }
    )
    const exceeded = {
      ...base,
      runId: "00000000-0000-4000-8000-000000000004",
      feature: "training" as const,
      inputTokens: 20
    }
    await reportAgentUsage(database, alerts, events, exceeded, {
      runTokens: 1_000,
      dailyTokens: 100
    })
    await reportAgentUsage(database, alerts, events, exceeded, {
      runTokens: 1_000,
      dailyTokens: 100
    })

    expect(await database.select().from(operationalAlerts)).toEqual([
      expect.objectContaining({
        code: "token_budget_exceeded",
        objectType: "usage_utc_day",
        objectId: "2026-08-11"
      })
    ])
    expect(events.events).toContainEqual(
      expect.objectContaining({
        type: "token_budget",
        window: "utc_day",
        state: "exceeded",
        consumedTokens: 110,
        budgetTokens: 100
      })
    )
    expect(JSON.stringify(events.events)).not.toContain("message")
  })

  it("creates one content-free alert when a run budget is exceeded", async () => {
    const database = createCoreDatabase(env.DB)
    const alerts = makeAlertStore(database, {
      now: () => new Date("2026-08-11T12:00:00.000Z"),
      randomUuid: () => "00000000-0000-4000-8000-000000000099"
    })
    await reportAgentUsage(
      database,
      alerts,
      captureEvents(),
      {
        runId: "00000000-0000-4000-8000-000000000003",
        ownerId,
        correlationId,
        feature: "journal",
        provider: "openai-codex",
        model: "test-model",
        status: "completed",
        inputTokens: 90,
        outputTokens: 20,
        toolCalls: 1,
        durationMs: 25,
        occurredAt: "2026-08-11T10:00:00.000Z"
      },
      { runTokens: 100, dailyTokens: 1_000 }
    )
    expect(await database.select().from(operationalAlerts)).toEqual([
      expect.objectContaining({
        code: "token_budget_exceeded",
        objectType: "agent_run",
        objectId: "00000000-0000-4000-8000-000000000003"
      })
    ])
  })

  it("creates one alert for an actionable agent failure", async () => {
    const database = createCoreDatabase(env.DB)
    const alerts = makeAlertStore(database, {
      now: () => new Date("2026-08-11T12:00:00.000Z"),
      randomUuid: () => "00000000-0000-4000-8000-000000000099"
    })
    const result = {
      protocolVersion: 1 as const,
      runId: "00000000-0000-4000-8000-000000000003",
      correlationId,
      status: "failed" as const,
      errorCode: "timeout" as const,
      model: "test-model",
      durationMs: 60_000,
      inputTokens: 0,
      outputTokens: 0,
      toolCalls: 0
    }

    await reportAgentFailure(alerts, ownerId, result)
    await reportAgentFailure(alerts, ownerId, result)

    expect(await database.select().from(operationalAlerts)).toEqual([
      expect.objectContaining({
        code: "agent_run_failed",
        objectType: "agent_run",
        objectId: result.runId
      })
    ])
  })

  it("creates a distinct alert when the provider rejects quota", async () => {
    const database = createCoreDatabase(env.DB)
    const alerts = makeAlertStore(database, {
      now: () => new Date("2026-08-11T12:00:00.000Z"),
      randomUuid: () => "00000000-0000-4000-8000-000000000099"
    })
    await reportAgentFailure(alerts, ownerId, {
      protocolVersion: 1,
      runId: "00000000-0000-4000-8000-000000000003",
      correlationId,
      status: "failed",
      errorCode: "quota",
      model: "test-model",
      durationMs: 1,
      inputTokens: 0,
      outputTokens: 0,
      toolCalls: 0
    })
    expect(await database.select().from(operationalAlerts)).toEqual([
      expect.objectContaining({
        code: "agent_quota_exhausted",
        objectType: "agent_run"
      })
    ])
  })
})
