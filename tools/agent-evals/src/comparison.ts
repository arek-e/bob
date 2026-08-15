import { metricNames, type EvaluationReport, type MetricName } from "./gate.ts"

export interface MetricComparison {
  readonly baseline: number
  readonly candidate: number
  readonly improvement: number
  readonly status: "improved" | "unchanged" | "regressed"
}

export interface EvaluationComparison {
  readonly schemaVersion: 1 | 2
  readonly suiteId: string
  readonly passed: boolean
  readonly regressedCases: readonly string[]
  readonly improvedCases: readonly string[]
  readonly metrics: Readonly<Record<MetricName, MetricComparison>>
  readonly failures: readonly string[]
}

function comparisonStatus(improvement: number): MetricComparison["status"] {
  if (improvement > 0) return "improved"
  if (improvement < 0) return "regressed"
  return "unchanged"
}

export function compareEvaluationReports(
  baseline: EvaluationReport,
  candidate: EvaluationReport
): EvaluationComparison {
  if (candidate.suiteId !== baseline.suiteId) throw new Error("comparison_suite_id_mismatch")
  if (candidate.schemaVersion !== baseline.schemaVersion) {
    throw new Error("comparison_schema_version_mismatch")
  }

  const baselineCases = new Map(baseline.results.map((result) => [result.caseId, result]))
  const candidateCases = new Map(candidate.results.map((result) => [result.caseId, result]))
  if (
    baselineCases.size !== candidateCases.size ||
    [...baselineCases.keys()].some((caseId) => !candidateCases.has(caseId))
  ) {
    throw new Error("comparison_case_set_mismatch")
  }

  const regressedCases = [...baselineCases].flatMap(([caseId, result]) =>
    result.passed && candidateCases.get(caseId)?.passed === false ? [caseId] : []
  )
  const improvedCases = [...baselineCases].flatMap(([caseId, result]) =>
    !result.passed && candidateCases.get(caseId)?.passed === true ? [caseId] : []
  )
  // SAFETY: metricNames supplies every MetricName exactly once.
  const metrics = Object.fromEntries(
    metricNames.map((name) => {
      const baselineMetric = baseline.metrics[name]
      const candidateMetric = candidate.metrics[name]
      const improvement =
        baselineMetric.comparison === "min"
          ? candidateMetric.value - baselineMetric.value
          : baselineMetric.value - candidateMetric.value
      return [
        name,
        {
          baseline: baselineMetric.value,
          candidate: candidateMetric.value,
          improvement,
          status: comparisonStatus(improvement)
        } satisfies MetricComparison
      ]
    })
  ) as Record<MetricName, MetricComparison>
  const failures = [
    ...regressedCases.map((caseId) => `case_regressed:${caseId}`),
    ...metricNames
      .filter((name) => metrics[name].status === "regressed")
      .map((name) => `metric_regressed:${name}`),
    ...candidate.failures.map((failure) => `candidate_failed:${failure}`)
  ]

  return {
    schemaVersion: baseline.schemaVersion,
    suiteId: baseline.suiteId,
    passed: failures.length === 0,
    regressedCases,
    improvedCases,
    metrics,
    failures
  }
}
