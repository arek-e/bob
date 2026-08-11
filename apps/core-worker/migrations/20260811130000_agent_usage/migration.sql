CREATE TABLE `agent_usage` (
	`run_id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`correlation_id` text NOT NULL,
	`feature` text NOT NULL,
	`workflow` text NOT NULL,
	`provider` text NOT NULL,
	`model` text NOT NULL,
	`status` text NOT NULL,
	`input_tokens` integer NOT NULL,
	`output_tokens` integer NOT NULL,
	`tool_calls` integer NOT NULL,
	`duration_ms` integer NOT NULL,
	`occurred_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `agent_usage_owner_time_idx` ON `agent_usage` (`user_id`,`occurred_at`);
--> statement-breakpoint
CREATE INDEX `agent_usage_feature_workflow_idx` ON `agent_usage` (`user_id`,`feature`,`workflow`,`occurred_at`);
