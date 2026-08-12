DROP INDEX `agent_runs_inbound_uq`;
--> statement-breakpoint
CREATE UNIQUE INDEX `agent_runs_legacy_inbound_uq` ON `agent_runs` (`inbound_event_id`)
WHERE `turn_id` IS NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX `agent_runs_turn_revision_uq` ON `agent_runs` (`turn_id`,`turn_revision`)
WHERE `turn_id` IS NOT NULL AND `turn_revision` IS NOT NULL;
