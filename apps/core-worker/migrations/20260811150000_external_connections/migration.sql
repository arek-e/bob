CREATE TABLE `external_connections` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`provider` text NOT NULL,
	`integration_id` text NOT NULL,
	`connection_id` text NOT NULL,
	`status` text NOT NULL,
	`connected_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `external_connections_owner_provider_uq` ON `external_connections` (`owner_id`,`provider`);
--> statement-breakpoint
CREATE UNIQUE INDEX `external_connections_nango_uq` ON `external_connections` (`integration_id`,`connection_id`);
--> statement-breakpoint
CREATE INDEX `external_connections_owner_idx` ON `external_connections` (`owner_id`);
