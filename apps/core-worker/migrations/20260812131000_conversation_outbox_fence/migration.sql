ALTER TABLE `outbox_messages` ADD `conversation_turn_id` text;
--> statement-breakpoint
ALTER TABLE `outbox_messages` ADD `conversation_turn_revision` integer;
