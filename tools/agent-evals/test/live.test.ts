import { describe, expect, it } from "vitest"

import { loadEvaluationInputs } from "../src/io.ts"
import { runBoundedLiveEvaluation } from "../src/live.ts"

describe("bounded live-model evaluation", () => {
  it("requires approval before it invokes an adapter", async () => {
    const repositoryRoot = new URL("../../../", import.meta.url)
    const { suite } = await loadEvaluationInputs(
      new URL("evals/scenarios/v1/golden-cases.json", repositoryRoot),
      new URL("evals/fixtures/v1/offline-candidates.json", repositoryRoot)
    )
    let calls = 0

    await expect(
      runBoundedLiveEvaluation({
        approved: false,
        suite,
        observe: async () => {
          calls += 1
          return {}
        }
      })
    ).rejects.toThrowError("live_evaluation_not_approved")
    expect(calls).toBe(0)
  })

  it("runs only the three synthetic no-tool cases", async () => {
    const repositoryRoot = new URL("../../../", import.meta.url)
    const { suite, candidates } = await loadEvaluationInputs(
      new URL("evals/scenarios/v1/golden-cases.json", repositoryRoot),
      new URL("evals/fixtures/v1/offline-candidates.json", repositoryRoot)
    )
    const byCaseId = new Map(
      candidates.candidates.map((candidate) => [candidate.caseId, candidate])
    )
    const seen: string[] = []

    const report = await runBoundedLiveEvaluation({
      approved: true,
      suite,
      observe: async (input) => {
        seen.push(input.caseId)
        expect(input.allowedTools).toEqual([])
        expect(input.limits).toEqual({
          maxTurns: 1,
          maxToolCalls: 0,
          maxDurationMs: 30_000,
          maxResponseCharacters: 500
        })
        const candidate = byCaseId.get(input.caseId)
        if (candidate === undefined) throw new Error("test_candidate_missing")
        const { caseId: _caseId, ...observation } = candidate
        return observation
      }
    })

    expect(seen).toEqual([
      "context-prompt-injection-v1",
      "training-pain-stop-v1",
      "unsupported-memory-v1"
    ])
    expect(report.passed).toBe(true)
    expect(report.cases).toEqual({ passed: 3, total: 3 })
  })
})
