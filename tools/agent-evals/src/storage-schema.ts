import { sql } from "drizzle-orm"
import {
  check,
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  uniqueIndex
} from "drizzle-orm/sqlite-core"

export const benchmarkRuns = sqliteTable(
  "benchmark_runs",
  {
    runId: text("run_id").primaryKey(),
    benchmarkId: text("benchmark_id").notNull(),
    protocol: text("protocol", { enum: ["official", "adapted"] }).notNull(),
    status: text("status", {
      enum: ["queued", "running", "completed", "failed", "cancelled"]
    }).notNull(),
    trigger: text("trigger", { enum: ["manual", "scheduled", "release"] }).notNull(),
    bobRevision: text("bob_revision").notNull(),
    benchmarkRevision: text("benchmark_revision").notNull(),
    datasetVersion: text("dataset_version").notNull(),
    adapterVersion: text("adapter_version").notNull(),
    model: text("model").notNull(),
    evaluator: text("evaluator").notNull(),
    variant: text("variant").notNull(),
    sampleCount: integer("sample_count").notNull(),
    repeatCount: integer("repeat_count").notNull(),
    startedAt: text("started_at"),
    completedAt: text("completed_at"),
    failureCode: text("failure_code"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull()
  },
  (table) => [
    index("benchmark_runs_benchmark_time_idx").on(table.benchmarkId, table.createdAt),
    index("benchmark_runs_status_time_idx").on(table.status, table.createdAt),
    check("benchmark_runs_protocol_ck", sql`${table.protocol} in ('official', 'adapted')`),
    check(
      "benchmark_runs_status_ck",
      sql`${table.status} in ('queued', 'running', 'completed', 'failed', 'cancelled')`
    ),
    check("benchmark_runs_trigger_ck", sql`${table.trigger} in ('manual', 'scheduled', 'release')`),
    check(
      "benchmark_runs_bob_revision_ck",
      sql`length(${table.bobRevision}) = 40 and ${table.bobRevision} not glob '*[^0-9a-f]*'`
    ),
    check(
      "benchmark_runs_benchmark_revision_ck",
      sql`length(${table.benchmarkRevision}) = 40 and ${table.benchmarkRevision} not glob '*[^0-9a-f]*'`
    ),
    check("benchmark_runs_sample_count_ck", sql`${table.sampleCount} >= 1`),
    check("benchmark_runs_repeat_count_ck", sql`${table.repeatCount} between 1 and 100`),
    check(
      "benchmark_runs_terminal_time_ck",
      sql`(${table.status} in ('completed', 'failed', 'cancelled') and ${table.completedAt} is not null) or (${table.status} in ('queued', 'running') and ${table.completedAt} is null)`
    )
  ]
)

export const benchmarkScores = sqliteTable(
  "benchmark_scores",
  {
    runId: text("run_id")
      .notNull()
      .references(() => benchmarkRuns.runId, { onDelete: "restrict" }),
    metricName: text("metric_name").notNull(),
    value: real("value").notNull(),
    recordedAt: text("recorded_at").notNull()
  },
  (table) => [
    primaryKey({ columns: [table.runId, table.metricName] }),
    index("benchmark_scores_metric_idx").on(table.metricName, table.recordedAt),
    check("benchmark_scores_value_ck", sql`${table.value} between -1000000 and 1000000`)
  ]
)

export const benchmarkArtifacts = sqliteTable(
  "benchmark_artifacts",
  {
    artifactId: text("artifact_id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => benchmarkRuns.runId, { onDelete: "restrict" }),
    kind: text("kind", {
      enum: ["manifest", "raw_output", "evaluator_output", "log", "trace"]
    }).notNull(),
    objectKey: text("object_key").notNull(),
    sha256: text("sha256").notNull(),
    byteSize: integer("byte_size").notNull(),
    contentType: text("content_type").notNull(),
    createdAt: text("created_at").notNull()
  },
  (table) => [
    uniqueIndex("benchmark_artifacts_object_key_uq").on(table.objectKey),
    index("benchmark_artifacts_run_kind_idx").on(table.runId, table.kind),
    check(
      "benchmark_artifacts_kind_ck",
      sql`${table.kind} in ('manifest', 'raw_output', 'evaluator_output', 'log', 'trace')`
    ),
    check(
      "benchmark_artifacts_sha256_ck",
      sql`length(${table.sha256}) = 64 and ${table.sha256} not glob '*[^0-9a-f]*'`
    ),
    check("benchmark_artifacts_byte_size_ck", sql`${table.byteSize} >= 0`),
    check("benchmark_artifacts_object_key_ck", sql`${table.objectKey} glob 'runs/*'`)
  ]
)
