CREATE TABLE `conversation_turns` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`channel_id` text NOT NULL,
	`status` text NOT NULL,
	`revision` integer NOT NULL,
	`latest_inbound_event_id` text NOT NULL,
	`latest_message_id` text NOT NULL,
	`active_run_id` text,
	`active_run_revision` integer,
	`claimed_revision` integer,
	`claimed_at` text,
	`claim_expires_at` text,
	`quiet_until` text NOT NULL,
	`burst_expires_at` text NOT NULL,
	`reply_outbox_id` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`replied_at` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `conversation_turns_open_uq` ON `conversation_turns` (`user_id`,`channel_id`)
WHERE `status` <> 'replied';
--> statement-breakpoint
CREATE INDEX `conversation_turns_channel_status_idx` ON `conversation_turns` (`user_id`,`channel_id`,`status`,`updated_at`);
--> statement-breakpoint
CREATE TABLE `conversation_turn_messages` (
	`turn_id` text NOT NULL,
	`inbound_event_id` text NOT NULL,
	`message_id` text NOT NULL,
	`ordinal` integer NOT NULL,
	`revision` integer NOT NULL,
	`traceparent` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `conversation_turn_messages_event_uq` ON `conversation_turn_messages` (`inbound_event_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `conversation_turn_messages_ordinal_uq` ON `conversation_turn_messages` (`turn_id`,`ordinal`);
--> statement-breakpoint
CREATE INDEX `conversation_turn_messages_order_idx` ON `conversation_turn_messages` (`turn_id`,`ordinal`);
--> statement-breakpoint
ALTER TABLE `agent_runs` ADD `turn_id` text;
--> statement-breakpoint
ALTER TABLE `agent_runs` ADD `turn_revision` integer;
--> statement-breakpoint
ALTER TABLE `agent_runs` ADD `target_message_id` text;
