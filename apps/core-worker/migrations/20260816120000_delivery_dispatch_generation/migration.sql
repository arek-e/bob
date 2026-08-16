ALTER TABLE `outbox_messages` ADD `dispatch_generation` integer DEFAULT 0 NOT NULL;
