ALTER TABLE `outbox_messages` ADD `claim_token` text;
ALTER TABLE `outbox_messages` ADD `dead_lettered_at` text;
ALTER TABLE `outbox_messages` ADD `recovery_count` integer DEFAULT 0 NOT NULL;
ALTER TABLE `delivery_attempts` ADD `payload_fingerprint` text;
