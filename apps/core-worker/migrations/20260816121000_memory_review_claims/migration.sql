ALTER TABLE `memory_candidates` ADD `review_claim_action` text;
--> statement-breakpoint
ALTER TABLE `memory_candidates` ADD `review_claim_id` text;
--> statement-breakpoint
ALTER TABLE `memory_candidates` ADD `review_claim_expires_at` text;
--> statement-breakpoint
ALTER TABLE `memory_candidates` ADD `review_result_id` text;
--> statement-breakpoint
CREATE INDEX `memory_candidates_review_claim_idx` ON `memory_candidates` (`status`,`review_claim_expires_at`);
--> statement-breakpoint
CREATE TABLE `memory_review_claim_guards` (
	`claim_id` text PRIMARY KEY NOT NULL
);
