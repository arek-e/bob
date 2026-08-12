import {
  decodeCandidateSet,
  decodeEvaluationSuite,
  evaluateSuite,
  metricNames,
  type EvaluationReport
} from "@bob/agent-evals/runtime"

import candidateData from "../../../evals/fixtures/v2/offline-candidates.json"
import suiteData from "../../../evals/scenarios/v2/interaction-cases.json"

export interface CommittedEvaluation {
  readonly report: EvaluationReport
  readonly sampleCount: number
}

export function evaluateCommittedInteractionSuite(): CommittedEvaluation {
  const suite = decodeEvaluationSuite(suiteData)
  const candidates = decodeCandidateSet(candidateData)
  return {
    report: evaluateSuite(suite, candidates),
    sampleCount: suite.cases.length
  }
}

export function reportScores(report: EvaluationReport): readonly (readonly [string, number])[] {
  return [
    ["gatePass", report.passed ? 1 : 0],
    ...metricNames.map((name) => [name, report.metrics[name].value] as const)
  ]
}
