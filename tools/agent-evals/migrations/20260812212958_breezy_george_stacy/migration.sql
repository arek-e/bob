CREATE TABLE `benchmark_artifacts` (
	`artifact_id` text PRIMARY KEY,
	`run_id` text NOT NULL,
	`kind` text NOT NULL,
	`object_key` text NOT NULL,
	`sha256` text NOT NULL,
	`byte_size` integer NOT NULL,
	`content_type` text NOT NULL,
	`created_at` text NOT NULL,
	CONSTRAINT `fk_benchmark_artifacts_run_id_benchmark_runs_run_id_fk` FOREIGN KEY (`run_id`) REFERENCES `benchmark_runs`(`run_id`) ON DELETE RESTRICT,
	CONSTRAINT "benchmark_artifacts_kind_ck" CHECK("kind" in ('manifest', 'raw_output', 'evaluator_output', 'log', 'trace')),
	CONSTRAINT "benchmark_artifacts_sha256_ck" CHECK(length("sha256") = 64 and "sha256" not glob '*[^0-9a-f]*'),
	CONSTRAINT "benchmark_artifacts_byte_size_ck" CHECK("byte_size" >= 0),
	CONSTRAINT "benchmark_artifacts_object_key_ck" CHECK("object_key" glob 'runs/*')
);
--> statement-breakpoint
CREATE TABLE `benchmark_runs` (
	`run_id` text PRIMARY KEY,
	`benchmark_id` text NOT NULL,
	`protocol` text NOT NULL,
	`status` text NOT NULL,
	`trigger` text NOT NULL,
	`bob_revision` text NOT NULL,
	`benchmark_revision` text NOT NULL,
	`dataset_version` text NOT NULL,
	`adapter_version` text NOT NULL,
	`model` text NOT NULL,
	`evaluator` text NOT NULL,
	`variant` text NOT NULL,
	`sample_count` integer NOT NULL,
	`repeat_count` integer NOT NULL,
	`started_at` text,
	`completed_at` text,
	`failure_code` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT "benchmark_runs_protocol_ck" CHECK("protocol" in ('official', 'adapted')),
	CONSTRAINT "benchmark_runs_status_ck" CHECK("status" in ('queued', 'running', 'completed', 'failed', 'cancelled')),
	CONSTRAINT "benchmark_runs_trigger_ck" CHECK("trigger" in ('manual', 'scheduled', 'release')),
	CONSTRAINT "benchmark_runs_bob_revision_ck" CHECK(length("bob_revision") = 40 and "bob_revision" not glob '*[^0-9a-f]*'),
	CONSTRAINT "benchmark_runs_benchmark_revision_ck" CHECK(length("benchmark_revision") = 40 and "benchmark_revision" not glob '*[^0-9a-f]*'),
	CONSTRAINT "benchmark_runs_sample_count_ck" CHECK("sample_count" >= 1),
	CONSTRAINT "benchmark_runs_repeat_count_ck" CHECK("repeat_count" between 1 and 100),
	CONSTRAINT "benchmark_runs_terminal_time_ck" CHECK(("status" in ('completed', 'failed', 'cancelled') and "completed_at" is not null) or ("status" in ('queued', 'running') and "completed_at" is null))
);
--> statement-breakpoint
CREATE TABLE `benchmark_scores` (
	`run_id` text NOT NULL,
	`metric_name` text NOT NULL,
	`value` real NOT NULL,
	`recorded_at` text NOT NULL,
	CONSTRAINT `benchmark_scores_pk` PRIMARY KEY(`run_id`, `metric_name`),
	CONSTRAINT `fk_benchmark_scores_run_id_benchmark_runs_run_id_fk` FOREIGN KEY (`run_id`) REFERENCES `benchmark_runs`(`run_id`) ON DELETE RESTRICT,
	CONSTRAINT "benchmark_scores_value_ck" CHECK("value" between -1000000 and 1000000)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `benchmark_artifacts_object_key_uq` ON `benchmark_artifacts` (`object_key`);--> statement-breakpoint
CREATE INDEX `benchmark_artifacts_run_kind_idx` ON `benchmark_artifacts` (`run_id`,`kind`);--> statement-breakpoint
CREATE INDEX `benchmark_runs_benchmark_time_idx` ON `benchmark_runs` (`benchmark_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `benchmark_runs_status_time_idx` ON `benchmark_runs` (`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `benchmark_scores_metric_idx` ON `benchmark_scores` (`metric_name`,`recorded_at`);