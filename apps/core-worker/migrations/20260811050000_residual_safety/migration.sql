CREATE TABLE `operational_alerts` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`code` text NOT NULL,
	`object_type` text NOT NULL,
	`object_id` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`state` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`resolved_at` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `operational_alerts_idempotency_uq` ON `operational_alerts` (`idempotency_key`);
--> statement-breakpoint
CREATE INDEX `operational_alerts_owner_state_idx` ON `operational_alerts` (`user_id`,`state`,`created_at`);
