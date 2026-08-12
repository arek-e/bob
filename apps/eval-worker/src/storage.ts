import type { EvaluationReport } from "@bob/agent-evals/runtime"

import type { EvalWorkerBindings } from "./bindings.ts"

import { reportScores } from "./evaluation.ts"

const BENCHMARK_ID = "bob-interaction-v2"
const ADAPTER_VERSION = "cloudflare-synthetic-v1"
const EVALUATOR = "bob-deterministic-gate-v2"
const MODEL = "committed-fixture"
const VARIANT = "offline-candidates"

interface ExistingRun {
  readonly status: "running" | "completed" | "failed" | "cancelled"
}

interface GateScore {
  readonly value: number
}

export interface EvaluationRunInput {
  readonly bindings: EvalWorkerBindings
  readonly releaseSha: string
  readonly report: EvaluationReport
  readonly sampleCount: number
  readonly scheduledTime: number
}

export interface EvaluationRunResult {
  readonly runId: string
  readonly artifactKey: string
  readonly passed: boolean
  readonly duplicate: boolean
}

function assertReleaseSha(value: string): void {
  if (!/^[0-9a-f]{40}$/u.test(value)) throw new Error("evaluation_release_sha_invalid")
}

function runId(scheduledTime: number): string {
  if (!Number.isSafeInteger(scheduledTime) || scheduledTime < 0) {
    throw new Error("evaluation_scheduled_time_invalid")
  }
  return `scheduled-${scheduledTime}`
}

function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("")
}

async function sha256(
  bytes: Uint8Array<ArrayBuffer>
): Promise<{ readonly bytes: ArrayBuffer; readonly hex: string }> {
  const digest = await crypto.subtle.digest("SHA-256", bytes)
  return { bytes: digest, hex: bytesToHex(new Uint8Array(digest)) }
}

function manifest(input: EvaluationRunInput, id: string, occurredAt: string): object {
  return {
    schemaVersion: 1,
    dataClass: "synthetic_evaluation_result",
    run: {
      runId: id,
      benchmarkId: BENCHMARK_ID,
      trigger: "scheduled",
      sourceRevision: input.releaseSha,
      datasetVersion: input.report.suiteId,
      adapterVersion: ADAPTER_VERSION,
      evaluator: EVALUATOR,
      model: MODEL,
      variant: VARIANT,
      sampleCount: input.sampleCount,
      repeatCount: 1,
      occurredAt
    },
    report: input.report
  }
}

async function startRun(
  input: EvaluationRunInput,
  id: string,
  occurredAt: string
): Promise<boolean> {
  const existing = await input.bindings.EVAL_DB.prepare(
    "SELECT status FROM benchmark_runs WHERE run_id = ?"
  )
    .bind(id)
    .first<ExistingRun>()

  if (existing?.status === "completed") return true

  if (existing === null) {
    await input.bindings.EVAL_DB.prepare(
      `INSERT OR IGNORE INTO benchmark_runs (
        run_id, benchmark_id, protocol, status, trigger, bob_revision,
        benchmark_revision, dataset_version, adapter_version, model,
        evaluator, variant, sample_count, repeat_count, started_at,
        completed_at, failure_code, created_at, updated_at
      ) VALUES (?, ?, 'adapted', 'running', 'scheduled', ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, NULL, NULL, ?, ?)`
    )
      .bind(
        id,
        BENCHMARK_ID,
        input.releaseSha,
        input.releaseSha,
        input.report.suiteId,
        ADAPTER_VERSION,
        MODEL,
        EVALUATOR,
        VARIANT,
        input.sampleCount,
        occurredAt,
        occurredAt,
        occurredAt
      )
      .run()
  } else if (existing.status !== "running") {
    await input.bindings.EVAL_DB.prepare(
      "UPDATE benchmark_runs SET status = 'running', completed_at = NULL, failure_code = NULL, updated_at = ? WHERE run_id = ?"
    )
      .bind(occurredAt, id)
      .run()
  }

  return false
}

async function duplicateResult(
  bindings: EvalWorkerBindings,
  id: string
): Promise<EvaluationRunResult> {
  const score = await bindings.EVAL_DB.prepare(
    "SELECT value FROM benchmark_scores WHERE run_id = ? AND metric_name = 'gatePass'"
  )
    .bind(id)
    .first<GateScore>()
  const artifact = await bindings.EVAL_DB.prepare(
    "SELECT object_key FROM benchmark_artifacts WHERE run_id = ? AND kind = 'manifest'"
  )
    .bind(id)
    .first<{ readonly object_key: string }>()
  if (score === null || artifact === null) throw new Error("evaluation_completed_run_incomplete")
  return {
    runId: id,
    artifactKey: artifact.object_key,
    passed: score.value === 1,
    duplicate: true
  }
}

async function putManifest(
  bindings: EvalWorkerBindings,
  key: string,
  bytes: Uint8Array<ArrayBuffer>,
  digest: ArrayBuffer
): Promise<void> {
  const object = await bindings.EVAL_ARTIFACTS.put(key, bytes, {
    onlyIf: { etagDoesNotMatch: "*" },
    httpMetadata: { contentType: "application/json" },
    customMetadata: { dataClass: "synthetic_evaluation_result" },
    sha256: digest
  })
  if (object !== null) return

  const existing = await bindings.EVAL_ARTIFACTS.head(key)
  const existingDigest = existing?.checksums.sha256
  if (
    existing === null ||
    existing.size !== bytes.byteLength ||
    existingDigest === undefined ||
    bytesToHex(new Uint8Array(existingDigest)) !== bytesToHex(new Uint8Array(digest))
  ) {
    throw new Error("evaluation_artifact_conflict")
  }
}

async function completeRun(
  input: EvaluationRunInput,
  id: string,
  artifactKey: string,
  artifactSha256: string,
  artifactBytes: number,
  completedAt: string
): Promise<void> {
  const statements = [
    input.bindings.EVAL_DB.prepare(
      "UPDATE benchmark_runs SET status = 'completed', completed_at = ?, failure_code = NULL, updated_at = ? WHERE run_id = ?"
    ).bind(completedAt, completedAt, id),
    ...reportScores(input.report).map(([name, value]) =>
      input.bindings.EVAL_DB.prepare(
        "INSERT OR REPLACE INTO benchmark_scores (run_id, metric_name, value, recorded_at) VALUES (?, ?, ?, ?)"
      ).bind(id, name, value, completedAt)
    ),
    input.bindings.EVAL_DB.prepare(
      `INSERT OR REPLACE INTO benchmark_artifacts (
        artifact_id, run_id, kind, object_key, sha256, byte_size, content_type, created_at
      ) VALUES (?, ?, 'manifest', ?, ?, ?, 'application/json', ?)`
    ).bind(`${id}-manifest`, id, artifactKey, artifactSha256, artifactBytes, completedAt)
  ]
  await input.bindings.EVAL_DB.batch(statements)
}

export async function recordEvaluationRun(input: EvaluationRunInput): Promise<EvaluationRunResult> {
  assertReleaseSha(input.releaseSha)
  const id = runId(input.scheduledTime)
  const occurredAt = new Date(input.scheduledTime).toISOString()
  if (await startRun(input, id, occurredAt)) {
    return duplicateResult(input.bindings, id)
  }

  const encoded = new TextEncoder().encode(JSON.stringify(manifest(input, id, occurredAt)))
  const digest = await sha256(encoded)
  const artifactKey = `runs/${BENCHMARK_ID}/${id}/${digest.hex}/manifest.json`
  await putManifest(input.bindings, artifactKey, encoded, digest.bytes)
  await completeRun(
    input,
    id,
    artifactKey,
    digest.hex,
    encoded.byteLength,
    new Date().toISOString()
  )

  return { runId: id, artifactKey, passed: input.report.passed, duplicate: false }
}

export async function failEvaluationRun(
  bindings: EvalWorkerBindings,
  scheduledTime: number,
  failureCode: string
): Promise<void> {
  const id = runId(scheduledTime)
  const completedAt = new Date().toISOString()
  await bindings.EVAL_DB.prepare(
    "UPDATE benchmark_runs SET status = 'failed', completed_at = ?, failure_code = ?, updated_at = ? WHERE run_id = ? AND status != 'completed'"
  )
    .bind(completedAt, failureCode, completedAt, id)
    .run()
}
