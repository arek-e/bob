ALTER TABLE `users` ADD `locale` text DEFAULT 'en' NOT NULL;
--> statement-breakpoint
ALTER TABLE `users` ADD `hour_cycle` text DEFAULT 'auto' NOT NULL;
