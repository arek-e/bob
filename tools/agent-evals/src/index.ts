import { readFile } from "node:fs/promises"

import { AgentRunResult } from "@bob/contracts/agent"
import { Schema } from "effect"

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

const inputPath = process.argv[2]
if (inputPath !== undefined) {
  const evaluation = evaluateResult(JSON.parse(await readFile(inputPath, "utf8")) as unknown)
  console.log(JSON.stringify(evaluation))
  if (!evaluation.passed) process.exitCode = 1
}
