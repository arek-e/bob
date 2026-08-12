ALTER TABLE `inbound_events` ADD `service` text DEFAULT 'unknown' NOT NULL;
--> statement-breakpoint
ALTER TABLE `inbound_events` ADD `is_group` integer DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE `inbound_events` ADD `reaction_claimed_at` text;
--> statement-breakpoint
ALTER TABLE `outbox_messages` ADD `reply_to_provider_message_handle` text;
