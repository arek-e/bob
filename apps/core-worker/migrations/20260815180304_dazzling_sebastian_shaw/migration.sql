ALTER TABLE `fact_evidence` ADD `source_label` text;--> statement-breakpoint
ALTER TABLE `fact_evidence` ADD `source_occurred_at` text;--> statement-breakpoint
ALTER TABLE `memory_candidates` ADD `memory_class` text DEFAULT 'owner_fact' NOT NULL;--> statement-breakpoint
ALTER TABLE `memory_candidates` ADD `source_label` text;--> statement-breakpoint
ALTER TABLE `memory_candidates` ADD `source_occurred_at` text;--> statement-breakpoint
ALTER TABLE `memory_candidates` ADD `source_content_hash` text;--> statement-breakpoint
ALTER TABLE `search_documents` ADD `memory_class` text DEFAULT 'owner_episode' NOT NULL;
--> statement-breakpoint
UPDATE `search_documents` SET `memory_class` = 'owner_fact' WHERE `source_type` = 'fact_revision';
