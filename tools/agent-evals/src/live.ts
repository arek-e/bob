import {
  evaluateSuite,
  type EvaluationReport,
  type EvaluationRequest,
  type EvaluationSuite
} from "./gate.ts"
import { decodeCandidateSet } from "./schemas.ts"

const MAX_LIVE_CASES = 3
const LIVE_ADAPTER_TIMEOUT_MS = 35_000

export interface LiveEvaluationInput {
  readonly schemaVersion: 1
  readonly caseId: string
  readonly request: EvaluationRequest
  readonly allowedTools: readonly []
  readonly limits: {
    readonly maxTurns: 1
    readonly maxToolCalls: 0
    readonly maxDurationMs: 30_000
    readonly maxResponseCharacters: 500
  }
}

export interface LiveEvaluationOptions {
  readonly approved: boolean
  readonly suite: EvaluationSuite
  readonly observe: (input: LiveEvaluationInput) => Promise<unknown>
}

async function withTimeout<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("live_adapter_timeout")), LIVE_ADAPTER_TIMEOUT_MS)
      })
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

function assertLiveCaseIsSafe(scenario: EvaluationSuite["cases"][number]): void {
  if (scenario.expected.tools === undefined || scenario.expected.tools.length !== 0) {
    throw new Error("live_case_tools_not_empty")
  }
  if ((scenario.expected.toolArguments?.length ?? 0) > 0) {
    throw new Error("live_case_has_tool_arguments")
  }
  if (scenario.expected.structuredOutput !== undefined) {
    throw new Error("live_case_has_structured_output")
  }
}

export async function runBoundedLiveEvaluation(
  options: LiveEvaluationOptions
): Promise<EvaluationReport> {
  if (!options.approved) throw new Error("live_evaluation_not_approved")
  const scenarios = options.suite.cases.filter((scenario) => scenario.liveEligible)
  if (scenarios.length === 0) throw new Error("live_evaluation_has_no_cases")
  if (scenarios.length > MAX_LIVE_CASES) throw new Error("live_evaluation_case_limit_exceeded")
  scenarios.forEach(assertLiveCaseIsSafe)

  const observations: unknown[] = []
  for (const scenario of scenarios) {
    const result = await withTimeout(
      options.observe({
        schemaVersion: 1,
        caseId: scenario.id,
        request: scenario.request,
        allowedTools: [],
        limits: {
          maxTurns: 1,
          maxToolCalls: 0,
          maxDurationMs: 30_000,
          maxResponseCharacters: 500
        }
      })
    )
    if (result === null || typeof result !== "object" || Array.isArray(result)) {
      throw new Error("live_adapter_output_invalid")
    }
    observations.push({ ...(result as Record<string, unknown>), caseId: scenario.id })
  }

  const candidates = decodeCandidateSet({
    schemaVersion: 1,
    suiteId: options.suite.suiteId,
    dataClass: "synthetic",
    candidates: observations
  })
  const liveSuite: EvaluationSuite = { ...options.suite, cases: scenarios }
  return evaluateSuite(liveSuite, candidates)
}
