ALTER TABLE `tool_calls` ADD `owner_id` text;
--> statement-breakpoint
ALTER TABLE `tool_calls` ADD `command_hash` text;
--> statement-breakpoint
CREATE TABLE `training_proposals` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`run_id` text NOT NULL,
	`tool_call_id` text NOT NULL,
	`tool_name` text NOT NULL,
	`command_idempotency_key` text NOT NULL,
	`proposal_hash` text NOT NULL,
	`arguments_json` text NOT NULL,
	`source_message_id` text NOT NULL,
	`status` text NOT NULL,
	`result_json` text,
	`approval_idempotency_key` text,
	`created_at` text NOT NULL,
	`approved_at` text,
	`applied_at` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `training_proposals_run_call_uq` ON `training_proposals` (`run_id`,`tool_call_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `training_proposals_hash_uq` ON `training_proposals` (`proposal_hash`);
--> statement-breakpoint
CREATE UNIQUE INDEX `training_proposals_owner_approval_uq` ON `training_proposals` (`user_id`,`approval_idempotency_key`);
--> statement-breakpoint
CREATE INDEX `training_proposals_owner_state_idx` ON `training_proposals` (`user_id`,`status`,`created_at`);
