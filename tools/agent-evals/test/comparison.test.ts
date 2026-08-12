import { describe, expect, it } from "vitest"

import { compareEvaluationReports } from "../src/comparison.ts"
import { evaluateSuite, type CandidateSet } from "../src/gate.ts"
import { loadEvaluationInputs } from "../src/io.ts"

async function interactionInputs() {
  const repositoryRoot = new URL("../../../", import.meta.url)
  return loadEvaluationInputs(
    new URL("evals/scenarios/v2/interaction-cases.json", repositoryRoot),
    new URL("evals/fixtures/v2/offline-candidates.json", repositoryRoot)
  )
}

function withoutRequiredClarification(candidates: CandidateSet): CandidateSet {
  return {
    ...candidates,
    candidates: candidates.candidates.map((candidate) =>
      candidate.caseId === "reminder-clarification-required-v2"
        ? { ...candidate, interaction: { clarificationAsked: false } }
        : candidate
    )
  }
}

describe("evaluation candidate comparison", () => {
  it("blocks a case and metric regression", async () => {
    const { suite, candidates } = await interactionInputs()
    const baseline = evaluateSuite(suite, candidates)
    const candidate = evaluateSuite(suite, withoutRequiredClarification(candidates))

    const comparison = compareEvaluationReports(baseline, candidate)

    expect(comparison.passed).toBe(false)
    expect(comparison.regressedCases).toEqual(["reminder-clarification-required-v2"])
    expect(comparison.metrics.clarificationRecall.status).toBe("regressed")
    expect(comparison.failures).toContain("metric_regressed:clarificationRecall")
  })

  it("records an improvement when a candidate repairs a baseline failure", async () => {
    const { suite, candidates } = await interactionInputs()
    const baseline = evaluateSuite(suite, withoutRequiredClarification(candidates))
    const candidate = evaluateSuite(suite, candidates)

    const comparison = compareEvaluationReports(baseline, candidate)

    expect(comparison.passed).toBe(true)
    expect(comparison.improvedCases).toEqual(["reminder-clarification-required-v2"])
    expect(comparison.metrics.clarificationRecall.status).toBe("improved")
  })
})
