import { applyD1Migrations, createScheduledController, reset } from "cloudflare:test"
import { env } from "cloudflare:workers"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import worker from "../src/index.ts"

declare global {
  namespace Cloudflare {
    interface Env {
      EVAL_DB: D1Database
      EVAL_ARTIFACTS: R2Bucket
      BOB_RELEASE_SHA: string
      TEST_MIGRATIONS: string
    }
  }
}

interface TestMigration {
  readonly name: string
  readonly queries: readonly string[]
}

const scheduledTime = Date.parse("2026-08-13T03:17:00.000Z")

beforeEach(async () => {
  await applyD1Migrations(env.EVAL_DB, JSON.parse(env.TEST_MIGRATIONS) as TestMigration[])
})

afterEach(async () => {
  await reset()
})

async function runScheduled(): Promise<void> {
  const handler = worker.scheduled
  if (handler === undefined) throw new Error("scheduled_handler_missing")
  await handler(
    createScheduledController({ cron: "17 3 * * *", scheduledTime }),
    env,
    {} as ExecutionContext
  )
}

describe("scheduled evaluation runner", () => {
  it("stores one content-free report and is idempotent", async () => {
    await Promise.all([runScheduled(), runScheduled()])
    await runScheduled()

    const runs = await env.EVAL_DB.prepare(
      "SELECT run_id, benchmark_id, status, trigger, model, sample_count, failure_code FROM benchmark_runs"
    ).all<{
      run_id: string
      benchmark_id: string
      status: string
      trigger: string
      model: string
      sample_count: number
      failure_code: string | null
    }>()
    expect(runs.results).toEqual([
      {
        run_id: `scheduled-${scheduledTime}`,
        benchmark_id: "bob-interaction-v2",
        status: "completed",
        trigger: "scheduled",
        model: "committed-fixture",
        sample_count: 12,
        failure_code: null
      }
    ])

    const scores = await env.EVAL_DB.prepare(
      "SELECT metric_name, value FROM benchmark_scores ORDER BY metric_name"
    ).all<{ metric_name: string; value: number }>()
    expect(scores.results).toContainEqual({ metric_name: "gatePass", value: 1 })
    expect(scores.results).toContainEqual({ metric_name: "clarificationPrecision", value: 1 })

    const artifacts = await env.EVAL_DB.prepare(
      "SELECT object_key, sha256, byte_size, content_type FROM benchmark_artifacts"
    ).all<{ object_key: string; sha256: string; byte_size: number; content_type: string }>()
    expect(artifacts.results).toHaveLength(1)
    const artifact = artifacts.results[0]!
    expect(artifact.object_key).toMatch(
      /^runs\/bob-interaction-v2\/scheduled-\d+\/[0-9a-f]{64}\/manifest\.json$/u
    )
    expect(artifact.content_type).toBe("application/json")

    const object = await env.EVAL_ARTIFACTS.get(artifact.object_key)
    expect(object).not.toBeNull()
    const bytes = new Uint8Array(await object!.arrayBuffer())
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))
    const digestHex = [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("")
    expect(digestHex).toBe(artifact.sha256)
    expect(bytes.byteLength).toBe(artifact.byte_size)

    const body = new TextDecoder().decode(bytes)
    const manifest = JSON.parse(body) as Record<string, unknown>
    expect(manifest).toMatchObject({
      schemaVersion: 1,
      dataClass: "synthetic_evaluation_result",
      report: { passed: true, suiteId: "bob-personal-agent-interaction-v2" }
    })
    expect(body).not.toContain("userText")
    expect((await env.EVAL_ARTIFACTS.list()).objects).toHaveLength(1)
  })
})
