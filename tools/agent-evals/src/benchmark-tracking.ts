import { Schema } from "effect"

const NonEmptyString = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(240))
const HttpsUrl = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(500),
  Schema.isPattern(/^https:\/\//)
)
const IsoDate = Schema.String.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}$/))
const IsoDateTime = Schema.String.check(
  Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/)
)
const GitRevision = Schema.String.check(Schema.isPattern(/^[0-9a-f]{40}$/))
const Identifier = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(100),
  Schema.isPattern(/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/)
)
const ArtifactKey = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(500),
  Schema.isPattern(
    /^runs\/[a-z0-9]+(?:[._-][a-z0-9]+)*\/[a-z0-9]+(?:[._-][a-z0-9]+)*\/[0-9a-f]{64}\/manifest\.json$/
  )
)
const Sha256 = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/))

const BenchmarkMetricDefinition = Schema.Struct({
  name: Identifier,
  label: NonEmptyString,
  direction: Schema.Literals(["max", "min"]),
  unit: Schema.Literals(["rate", "score", "milliseconds"])
})

const BenchmarkDefinition = Schema.Struct({
  id: Identifier,
  name: NonEmptyString,
  paperUrl: HttpsUrl,
  repositoryUrl: Schema.optionalKey(HttpsUrl),
  license: Schema.optionalKey(NonEmptyString),
  availability: Schema.Literals(["public_runner", "public_artifact", "paper_only"]),
  trackingMode: Schema.Literals(["official_score", "adapted_only", "reference_only"]),
  adapterStatus: Schema.Literals([
    "not_started",
    "planned",
    "ready",
    "blocked_by_capabilities",
    "waiting_for_release",
    "not_applicable"
  ]),
  officialMetrics: Schema.Array(BenchmarkMetricDefinition),
  notes: NonEmptyString
})

const BenchmarkCatalogSchema = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  verifiedAt: IsoDate,
  benchmarks: Schema.Array(BenchmarkDefinition).check(Schema.isMinLength(1))
})

const BenchmarkScore = Schema.Struct({
  name: Identifier,
  value: Schema.Number.check(Schema.isBetween({ minimum: -1_000_000, maximum: 1_000_000 }))
})

const BenchmarkRun = Schema.Struct({
  runId: Identifier,
  benchmarkId: Identifier,
  protocol: Schema.Literals(["official", "adapted"]),
  completedAt: IsoDateTime,
  bobRevision: GitRevision,
  benchmarkRevision: GitRevision,
  datasetVersion: NonEmptyString,
  adapterVersion: NonEmptyString,
  model: NonEmptyString,
  evaluator: NonEmptyString,
  variant: NonEmptyString,
  sampleCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  repeatCount: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 })),
  scores: Schema.Array(BenchmarkScore).check(Schema.isMinLength(1)),
  artifactKey: ArtifactKey,
  artifactSha256: Sha256
})

const BenchmarkRunLedgerSchema = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  dataClass: Schema.Literal("public_benchmark_results"),
  runs: Schema.Array(BenchmarkRun)
})

export type BenchmarkDefinition = typeof BenchmarkDefinition.Type
export type BenchmarkCatalog = typeof BenchmarkCatalogSchema.Type
export type BenchmarkRun = typeof BenchmarkRun.Type
export type BenchmarkRunLedger = typeof BenchmarkRunLedgerSchema.Type

export interface BenchmarkTrackingItem {
  readonly benchmarkId: string
  readonly name: string
  readonly trackingMode: BenchmarkDefinition["trackingMode"]
  readonly adapterStatus: BenchmarkDefinition["adapterStatus"]
  readonly status: "not_run" | "official_score" | "adapted_score" | "reference_only"
  readonly latestRun?: BenchmarkRun
}

export interface BenchmarkTrackingReport {
  readonly schemaVersion: 1
  readonly verifiedAt: string
  readonly officialScores: { readonly recorded: number; readonly total: number }
  readonly benchmarks: readonly BenchmarkTrackingItem[]
}

function hasDuplicates(values: readonly string[]): boolean {
  return new Set(values).size !== values.length
}

function assertCatalogInvariants(catalog: BenchmarkCatalog): void {
  if (hasDuplicates(catalog.benchmarks.map((benchmark) => benchmark.id))) {
    throw new Error("duplicate_benchmark")
  }
  for (const benchmark of catalog.benchmarks) {
    if (hasDuplicates(benchmark.officialMetrics.map((metric) => metric.name))) {
      throw new Error("duplicate_benchmark_metric")
    }
    if (benchmark.trackingMode === "official_score") {
      if (benchmark.availability !== "public_runner") {
        throw new Error("official_benchmark_runner_missing")
      }
      if (benchmark.repositoryUrl === undefined || benchmark.officialMetrics.length === 0) {
        throw new Error("official_benchmark_metadata_missing")
      }
    } else if (
      benchmark.trackingMode === "reference_only" &&
      benchmark.officialMetrics.length > 0
    ) {
      throw new Error("untracked_benchmark_has_metrics")
    }
  }
}

function assertLedgerInvariants(catalog: BenchmarkCatalog, ledger: BenchmarkRunLedger): void {
  if (hasDuplicates(ledger.runs.map((run) => run.runId))) throw new Error("duplicate_benchmark_run")
  const benchmarks = new Map(catalog.benchmarks.map((benchmark) => [benchmark.id, benchmark]))
  for (const run of ledger.runs) {
    const benchmark = benchmarks.get(run.benchmarkId)
    if (benchmark === undefined) throw new Error("benchmark_run_without_catalog_entry")
    if (hasDuplicates(run.scores.map((score) => score.name))) {
      throw new Error("duplicate_benchmark_run_score")
    }
    const metrics = new Map(benchmark.officialMetrics.map((metric) => [metric.name, metric]))
    for (const score of run.scores) {
      const metric = metrics.get(score.name)
      if (metric === undefined) throw new Error("unknown_benchmark_run_score")
      if (metric.unit === "rate" && (score.value < 0 || score.value > 1)) {
        throw new Error("invalid_benchmark_rate")
      }
      if (metric.unit === "milliseconds" && score.value < 0) {
        throw new Error("invalid_benchmark_latency")
      }
    }
    if (run.protocol === "official" && benchmark.trackingMode !== "official_score") {
      throw new Error("benchmark_not_officially_comparable")
    }
    const expectedArtifactKey = `runs/${run.benchmarkId}/${run.runId}/${run.artifactSha256}/manifest.json`
    if (run.artifactKey !== expectedArtifactKey) {
      throw new Error("invalid_benchmark_artifact_key")
    }
  }
}

export function decodeBenchmarkCatalog(input: unknown): BenchmarkCatalog {
  try {
    const catalog = Schema.decodeUnknownSync(BenchmarkCatalogSchema)(input)
    assertCatalogInvariants(catalog)
    return catalog
  } catch {
    throw new Error("invalid_benchmark_catalog")
  }
}

export function decodeBenchmarkRunLedger(input: unknown): BenchmarkRunLedger {
  try {
    const ledger = Schema.decodeUnknownSync(BenchmarkRunLedgerSchema)(input)
    if (hasDuplicates(ledger.runs.map((run) => run.runId))) {
      throw new Error("duplicate_benchmark_run")
    }
    return ledger
  } catch {
    throw new Error("invalid_benchmark_run_ledger")
  }
}

export function summarizeBenchmarkTracking(
  catalog: BenchmarkCatalog,
  ledger: BenchmarkRunLedger
): BenchmarkTrackingReport {
  assertCatalogInvariants(catalog)
  assertLedgerInvariants(catalog, ledger)
  const benchmarks = catalog.benchmarks.map((benchmark): BenchmarkTrackingItem => {
    const runs = ledger.runs
      .filter((run) => run.benchmarkId === benchmark.id)
      .toSorted((left, right) => right.completedAt.localeCompare(left.completedAt))
    const officialRun = runs.find((run) => run.protocol === "official")
    const latestRun = officialRun ?? runs[0]
    const status =
      benchmark.trackingMode === "reference_only"
        ? "reference_only"
        : officialRun !== undefined
          ? "official_score"
          : latestRun !== undefined
            ? "adapted_score"
            : "not_run"
    return {
      benchmarkId: benchmark.id,
      name: benchmark.name,
      trackingMode: benchmark.trackingMode,
      adapterStatus: benchmark.adapterStatus,
      status,
      ...(latestRun === undefined ? {} : { latestRun })
    }
  })
  const scoreable = benchmarks.filter((benchmark) => benchmark.trackingMode === "official_score")
  return {
    schemaVersion: 1,
    verifiedAt: catalog.verifiedAt,
    officialScores: {
      recorded: scoreable.filter((benchmark) => benchmark.status === "official_score").length,
      total: scoreable.length
    },
    benchmarks
  }
}
