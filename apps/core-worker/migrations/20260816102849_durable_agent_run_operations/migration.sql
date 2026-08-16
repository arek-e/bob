CREATE TABLE `agent_run_operations` (
	`id` text PRIMARY KEY,
	`run_id` text NOT NULL,
	`sequence` integer NOT NULL,
	`kind` text NOT NULL,
	`loop_version` integer NOT NULL,
	`payload_ciphertext` text NOT NULL,
	`payload_iv` text NOT NULL,
	`payload_hash` text NOT NULL,
	`data_key_version` integer NOT NULL,
	`created_by_attempt_id` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agent_run_operations_sequence_uq` ON `agent_run_operations` (`run_id`,`sequence`);--> statement-breakpoint
CREATE INDEX `agent_run_operations_order_idx` ON `agent_run_operations` (`run_id`,`sequence`);