import { AgentRunResult } from "@bob/contracts/agent"
import { Schema } from "effect"
import { readFile } from "node:fs/promises"
import { pathToFileURL } from "node:url"

import { summarizeBenchmarkTracking, type BenchmarkTrackingReport } from "./benchmark-tracking.ts"
import { compareEvaluationReports, type EvaluationComparison } from "./comparison.ts"
import { coreEvaluationProfile } from "./evaluation-packs/core.ts"
import { evaluateSuite, type EvaluationReport } from "./gate.ts"
import {
  loadBenchmarkCatalog,
  loadBenchmarkRunLedger,
  loadCandidateSet,
  loadEvaluationInputs,
  loadEvaluationSuite
} from "./io.ts"
import { runBoundedLiveEvaluation } from "./live.ts"
import { evaluateProfile } from "./packs.ts"
import { createProcessAdapter } from "./process-adapter.ts"

export * from "./gate.ts"
export * from "./benchmark-tracking.ts"
export * from "./comparison.ts"
export * from "./io.ts"
export * from "./live.ts"
export * from "./packs.ts"
export * from "./evaluation-packs/core.ts"
export * from "./schemas.ts"

export interface DeterministicEvaluation {
  readonly passed: boolean
  readonly failures: readonly string[]
}

export function evaluateResult<Input>(input: Input): DeterministicEvaluation {
  const result = Schema.decodeUnknownSync(AgentRunResult)(input)
  const failures: string[] = []
  if (result.status !== "completed") failures.push("agent_run_not_completed")
  if (result.responseText === undefined) failures.push("response_missing")
  if ((result.responseText?.length ?? 0) > 500) failures.push("response_too_long")
  if (/\bdementia\b/i.test(result.responseText ?? "")) failures.push("unsolicited_dementia_label")
  if (result.toolCalls < 0) failures.push("invalid_tool_count")
  return { passed: failures.length === 0, failures }
}

const repositoryRoot = new URL("../../../", import.meta.url)
const defaultSuite = new URL("evals/scenarios/v1/golden-cases.json", repositoryRoot)
const defaultCandidates = new URL("evals/fixtures/v1/offline-candidates.json", repositoryRoot)
const defaultBenchmarkCatalog = new URL("evals/benchmarks/catalog.json", repositoryRoot)
const defaultBenchmarkResults = new URL("evals/benchmarks/results.json", repositoryRoot)

function option(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name)
  if (index === -1) return undefined
  const value = args[index + 1]
  if (value === undefined || value.startsWith("--")) throw new Error("missing_option_value")
  return value
}

function optionValues(args: readonly string[], name: string): readonly string[] {
  return args.flatMap((value, index) =>
    value === name && args[index + 1] !== undefined ? [args[index + 1]!] : []
  )
}

function renderReport(report: EvaluationReport): string {
  const lines = [
    `Bob evaluation gate: ${report.passed ? "PASS" : "FAIL"}`,
    `Suite: ${report.suiteId}`,
    `Cases: ${report.cases.passed}/${report.cases.total}`
  ]
  for (const name of report.metricNames) {
    const metric = report.metrics[name]!
    lines.push(
      `${name}: ${metric.value.toFixed(3)} (${metric.comparison} ${metric.threshold.toFixed(3)}; ${metric.numerator}/${metric.denominator})`
    )
  }
  if (report.failures.length > 0) lines.push(`Failures: ${report.failures.join(", ")}`)
  return lines.join("\n")
}

async function runProfile(args: readonly string[]): Promise<void> {
  const id = option(args, "--profile") ?? "core"
  const profile =
    id === "core"
      ? coreEvaluationProfile
      : id === "transitional"
        ? (await import("./evaluation-packs/transitional.ts")).transitionalEvaluationProfile
        : undefined
  if (profile === undefined) throw new Error("evaluation_profile_unknown")
  const report = await evaluateProfile(profile)
  console.log(
    args.includes("--json")
      ? JSON.stringify(report)
      : [
          `Bob evaluation profile: ${report.passed ? "PASS" : "FAIL"}`,
          `Profile: ${report.profileId}`,
          ...report.packs.map((pack) => `${pack.packId}: ${pack.passed ? "PASS" : "FAIL"}`),
          ...(report.failures.length === 0 ? [] : [`Failures: ${report.failures.join(", ")}`])
        ].join("\n")
  )
  if (!report.passed) process.exitCode = 1
}

function renderComparison(comparison: EvaluationComparison): string {
  const lines = [
    `Bob candidate comparison: ${comparison.passed ? "PASS" : "FAIL"}`,
    `Suite: ${comparison.suiteId}`,
    `Regressed cases: ${comparison.regressedCases.length}`,
    `Improved cases: ${comparison.improvedCases.length}`
  ]
  if (comparison.failures.length > 0) {
    lines.push(`Failures: ${comparison.failures.join(", ")}`)
  }
  return lines.join("\n")
}

function renderBenchmarkTracking(report: BenchmarkTrackingReport): string {
  const lines = [
    "Bob public benchmark tracking",
    `Verified: ${report.verifiedAt}`,
    `Official scores: ${report.officialScores.recorded}/${report.officialScores.total}`
  ]
  for (const benchmark of report.benchmarks) {
    const status = benchmark.status.replaceAll("_", " ").toUpperCase()
    const scores = benchmark.latestRun?.scores
      .map((score) => `${score.name}=${score.value}`)
      .join(", ")
    lines.push(
      `${benchmark.name}: ${status}; adapter ${benchmark.adapterStatus}${scores === undefined ? "" : `; ${scores}`}`
    )
  }
  return lines.join("\n")
}

async function runOffline(args: readonly string[]): Promise<void> {
  const suitePath = option(args, "--suite") ?? defaultSuite
  const candidatePath = option(args, "--candidates") ?? defaultCandidates
  const { suite, candidates } = await loadEvaluationInputs(suitePath, candidatePath)
  const report = evaluateSuite(suite, candidates)
  console.log(args.includes("--json") ? JSON.stringify(report) : renderReport(report))
  if (!report.passed) process.exitCode = 1
}

async function runComparison(args: readonly string[]): Promise<void> {
  const suitePath = option(args, "--suite") ?? defaultSuite
  const baselinePath = option(args, "--baseline")
  const candidatePath = option(args, "--candidates")
  if (baselinePath === undefined) throw new Error("comparison_baseline_missing")
  if (candidatePath === undefined) throw new Error("comparison_candidate_missing")
  const [suite, baseline, candidate] = await Promise.all([
    loadEvaluationSuite(suitePath),
    loadCandidateSet(baselinePath),
    loadCandidateSet(candidatePath)
  ])
  const comparison = compareEvaluationReports(
    evaluateSuite(suite, baseline),
    evaluateSuite(suite, candidate)
  )
  console.log(args.includes("--json") ? JSON.stringify(comparison) : renderComparison(comparison))
  if (!comparison.passed) process.exitCode = 1
}

async function runBenchmarkTracking(args: readonly string[]): Promise<void> {
  const [catalog, ledger] = await Promise.all([
    loadBenchmarkCatalog(option(args, "--catalog") ?? defaultBenchmarkCatalog),
    loadBenchmarkRunLedger(option(args, "--results") ?? defaultBenchmarkResults)
  ])
  const report = summarizeBenchmarkTracking(catalog, ledger)
  console.log(args.includes("--json") ? JSON.stringify(report) : renderBenchmarkTracking(report))
}

async function runLegacyResult(path: string): Promise<void> {
  const evaluation = evaluateResult(JSON.parse(await readFile(path, "utf8")))
  console.log(JSON.stringify(evaluation))
  if (!evaluation.passed) process.exitCode = 1
}

async function runLive(args: readonly string[]): Promise<void> {
  if (!args.includes("--approve-live")) throw new Error("live_evaluation_not_approved")
  const adapterExecutable = option(args, "--adapter")
  if (adapterExecutable === undefined) throw new Error("live_adapter_missing")
  const suite = await loadEvaluationSuite(option(args, "--suite") ?? defaultSuite)
  if (suite.schemaVersion !== 1) throw new Error("live_evaluation_schema_version_unsupported")
  const report = await runBoundedLiveEvaluation({
    approved: true,
    suite,
    observe: createProcessAdapter(adapterExecutable, optionValues(args, "--adapter-arg"))
  })
  console.log(args.includes("--json") ? JSON.stringify(report) : renderReport(report))
  if (!report.passed) process.exitCode = 1
}

async function main(args: readonly string[]): Promise<void> {
  const command = args[0] ?? "offline"
  if (command === "offline") return runOffline(args.slice(1))
  if (command === "profile") return runProfile(args.slice(1))
  if (command === "compare") return runComparison(args.slice(1))
  if (command === "benchmarks") return runBenchmarkTracking(args.slice(1))
  if (command === "live") return runLive(args.slice(1))
  if (command === "result") {
    const path = args[1]
    if (path === undefined) throw new Error("result_path_missing")
    return runLegacyResult(path)
  }
  if (!command.startsWith("--")) return runLegacyResult(command)
  return runOffline(args)
}

const entry = process.argv[1]
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  main(process.argv.slice(2)).catch((cause: unknown) => {
    const message = cause instanceof Error ? cause.message : ""
    const code = /^[a-z0-9_]+$/.test(message) ? message : "evaluation_failed"
    console.error(`agent_eval_error:${code}`)
    process.exitCode = 1
  })
}
