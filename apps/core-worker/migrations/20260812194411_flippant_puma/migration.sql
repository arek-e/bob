CREATE TABLE `artifact_revisions` (
	`artifact_id` text NOT NULL,
	`revision` integer NOT NULL,
	`content_ciphertext` text NOT NULL,
	`content_iv` text NOT NULL,
	`rendered_text_ciphertext` text NOT NULL,
	`rendered_text_iv` text NOT NULL,
	`data_key_version` integer NOT NULL,
	`source_ids_json` text NOT NULL,
	`created_by_run_id` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `artifacts` (
	`id` text PRIMARY KEY,
	`user_id` text NOT NULL,
	`channel_id` text NOT NULL,
	`kind` text NOT NULL,
	`current_revision` integer NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
ALTER TABLE `outbox_messages` ADD `depends_on_outbox_id` text;
--> statement-breakpoint
ALTER TABLE `outbox_messages` ADD `artifact_id` text;
--> statement-breakpoint
ALTER TABLE `outbox_messages` ADD `artifact_revision` integer;
--> statement-breakpoint
CREATE UNIQUE INDEX `artifact_revisions_identity_uq` ON `artifact_revisions` (`artifact_id`,`revision`);
--> statement-breakpoint
CREATE INDEX `artifact_revisions_run_idx` ON `artifact_revisions` (`created_by_run_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `artifacts_owner_channel_kind_uq` ON `artifacts` (`user_id`,`channel_id`,`kind`);
--> statement-breakpoint
CREATE INDEX `artifacts_latest_idx` ON `artifacts` (`user_id`,`channel_id`,`updated_at`);
--> statement-breakpoint
CREATE INDEX `outbox_dependency_idx` ON `outbox_messages` (`depends_on_outbox_id`,`state`);
