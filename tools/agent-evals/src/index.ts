import { AgentRunResult } from "@bob/contracts/agent"
import { Schema } from "effect"
import { readFile } from "node:fs/promises"
import { pathToFileURL } from "node:url"

import { evaluateSuite, metricNames, type EvaluationReport } from "./gate.ts"
import { loadEvaluationInputs, loadEvaluationSuite } from "./io.ts"
import { runBoundedLiveEvaluation } from "./live.ts"
import { createProcessAdapter } from "./process-adapter.ts"

export * from "./gate.ts"
export * from "./io.ts"
export * from "./live.ts"
export * from "./schemas.ts"

export interface DeterministicEvaluation {
  readonly passed: boolean
  readonly failures: readonly string[]
}

export function evaluateResult(input: unknown): DeterministicEvaluation {
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
  for (const name of metricNames) {
    const metric = report.metrics[name]
    lines.push(
      `${name}: ${metric.value.toFixed(3)} (${metric.comparison} ${metric.threshold.toFixed(3)}; ${metric.numerator}/${metric.denominator})`
    )
  }
  if (report.failures.length > 0) lines.push(`Failures: ${report.failures.join(", ")}`)
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

async function runLegacyResult(path: string): Promise<void> {
  const evaluation = evaluateResult(JSON.parse(await readFile(path, "utf8")) as unknown)
  console.log(JSON.stringify(evaluation))
  if (!evaluation.passed) process.exitCode = 1
}

async function runLive(args: readonly string[]): Promise<void> {
  if (!args.includes("--approve-live")) throw new Error("live_evaluation_not_approved")
  const adapterExecutable = option(args, "--adapter")
  if (adapterExecutable === undefined) throw new Error("live_adapter_missing")
  const suite = await loadEvaluationSuite(option(args, "--suite") ?? defaultSuite)
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
  main(process.argv.slice(2)).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : ""
    const code = /^[a-z0-9_]+$/.test(message) ? message : "evaluation_failed"
    console.error(`agent_eval_error:${code}`)
    process.exitCode = 1
  })
}
