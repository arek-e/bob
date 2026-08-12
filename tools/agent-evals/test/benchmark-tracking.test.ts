import { describe, expect, it } from "vitest"

import { decodeBenchmarkRunLedger, summarizeBenchmarkTracking } from "../src/benchmark-tracking.ts"
import { loadBenchmarkCatalog, loadBenchmarkRunLedger } from "../src/io.ts"

const repositoryRoot = new URL("../../../", import.meta.url)
const catalogPath = new URL("evals/benchmarks/catalog.json", repositoryRoot)
const resultsPath = new URL("evals/benchmarks/results.json", repositoryRoot)

describe("public benchmark tracking", () => {
  it("shows official public benchmarks as not run without inventing scores", async () => {
    const [catalog, ledger] = await Promise.all([
      loadBenchmarkCatalog(catalogPath),
      loadBenchmarkRunLedger(resultsPath)
    ])

    const report = summarizeBenchmarkTracking(catalog, ledger)

    expect(report.officialScores).toEqual({ recorded: 0, total: 4 })
    expect(report.benchmarks).toHaveLength(9)
    expect(report.benchmarks.find((item) => item.benchmarkId === "longmemeval-v1")).toMatchObject({
      status: "not_run",
      adapterStatus: "planned"
    })
    expect(report.benchmarks.find((item) => item.benchmarkId === "op-bench")).toMatchObject({
      status: "reference_only",
      adapterStatus: "waiting_for_release"
    })
  })

  it("records a reproducible official score", async () => {
    const catalog = await loadBenchmarkCatalog(catalogPath)
    const ledger = decodeBenchmarkRunLedger({
      schemaVersion: 1,
      dataClass: "public_benchmark_results",
      runs: [
        {
          runId: "longmemeval-v1-2026-08-12",
          benchmarkId: "longmemeval-v1",
          protocol: "official",
          completedAt: "2026-08-12T10:00:00.000Z",
          bobRevision: "0000000000000000000000000000000000000000",
          benchmarkRevision: "1111111111111111111111111111111111111111",
          datasetVersion: "longmemeval_s_cleaned",
          adapterVersion: "bob-longmemeval-v1",
          model: "synthetic-test-model",
          evaluator: "official-evaluator",
          variant: "small",
          sampleCount: 500,
          repeatCount: 1,
          scores: [{ name: "qa_accuracy", value: 0.8 }],
          artifactKey: `runs/longmemeval-v1/longmemeval-v1-2026-08-12/${"2".repeat(64)}/manifest.json`,
          artifactSha256: "2".repeat(64)
        }
      ]
    })

    const report = summarizeBenchmarkTracking(catalog, ledger)

    expect(report.officialScores).toEqual({ recorded: 1, total: 4 })
    expect(report.benchmarks.find((item) => item.benchmarkId === "longmemeval-v1")).toMatchObject({
      status: "official_score",
      latestRun: {
        sampleCount: 500,
        scores: [{ name: "qa_accuracy", value: 0.8 }]
      }
    })
  })

  it("rejects an unknown metric from a benchmark run", async () => {
    const catalog = await loadBenchmarkCatalog(catalogPath)
    const ledger = decodeBenchmarkRunLedger({
      schemaVersion: 1,
      dataClass: "public_benchmark_results",
      runs: [
        {
          runId: "invalid-score-run",
          benchmarkId: "longmemeval-v1",
          protocol: "official",
          completedAt: "2026-08-12T10:00:00.000Z",
          bobRevision: "0000000000000000000000000000000000000000",
          benchmarkRevision: "1111111111111111111111111111111111111111",
          datasetVersion: "longmemeval_s_cleaned",
          adapterVersion: "bob-longmemeval-v1",
          model: "synthetic-test-model",
          evaluator: "official-evaluator",
          variant: "small",
          sampleCount: 500,
          repeatCount: 1,
          scores: [{ name: "paper_claimed_score", value: 1 }],
          artifactKey: `runs/longmemeval-v1/invalid-score-run/${"2".repeat(64)}/manifest.json`,
          artifactSha256: "2".repeat(64)
        }
      ]
    })

    expect(() => summarizeBenchmarkTracking(catalog, ledger)).toThrowError(
      "unknown_benchmark_run_score"
    )
  })
})
