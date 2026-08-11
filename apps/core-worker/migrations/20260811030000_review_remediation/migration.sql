ALTER TABLE `channels` ADD `opted_in_at` text;
--> statement-breakpoint
ALTER TABLE `inbound_events` ADD `recovery_count` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE `tool_calls` ADD `claim_token` text;
--> statement-breakpoint
ALTER TABLE `tool_calls` ADD `claimed_at` text;
--> statement-breakpoint
ALTER TABLE `tool_calls` ADD `claim_expires_at` text;
--> statement-breakpoint
ALTER TABLE `tool_calls` ADD `attempt_number` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE `outbox_messages` ADD `action_target_type` text;
--> statement-breakpoint
ALTER TABLE `outbox_messages` ADD `action_target_id` text;
--> statement-breakpoint
ALTER TABLE `journal_entries` ADD `handoff_id` text;
--> statement-breakpoint
CREATE UNIQUE INDEX `journal_entries_handoff_uq` ON `journal_entries` (`handoff_id`);
--> statement-breakpoint
CREATE TRIGGER `journal_entries_valid_handoff` BEFORE INSERT ON `journal_entries`
WHEN NEW.`handoff_id` IS NULL OR NOT EXISTS (
  SELECT 1 FROM `journal_handoffs`
  WHERE `id` = NEW.`handoff_id`
    AND `user_id` = NEW.`user_id`
    AND `consumed_at` IS NULL
    AND `expires_at` > NEW.`created_at`
)
BEGIN
  SELECT RAISE(ABORT, 'journal_handoff_invalid');
END;
--> statement-breakpoint
CREATE UNIQUE INDEX `short_reply_target_uq` ON `short_reply_bindings` (`outbound_message_id`,`command`,`target_type`,`target_id`);
--> statement-breakpoint
ALTER TABLE `memory_candidates` ADD `proposed_value_ciphertext` text;
--> statement-breakpoint
ALTER TABLE `memory_candidates` ADD `proposed_value_iv` text;
--> statement-breakpoint
ALTER TABLE `fact_revisions` ADD `value_ciphertext` text;
--> statement-breakpoint
ALTER TABLE `fact_revisions` ADD `value_iv` text;
--> statement-breakpoint
ALTER TABLE `routines` ADD `approval_source_type` text NOT NULL DEFAULT 'owner_message';
--> statement-breakpoint
ALTER TABLE `routines` ADD `approval_source_id` text NOT NULL DEFAULT 'legacy-unverified';
--> statement-breakpoint
CREATE UNIQUE INDEX `workout_sessions_one_active_uq` ON `workout_sessions` (`user_id`)
WHERE `status` = 'active';
--> statement-breakpoint
CREATE TRIGGER `workout_sets_validate` BEFORE INSERT ON `workout_sets`
WHEN NEW.`sequence` < 1
  OR NEW.`repetitions` < 1
  OR NEW.`repetitions` > 100
  OR NEW.`weight_grams` < 0
  OR NEW.`weight_grams` > 2000000
  OR NOT EXISTS (
    SELECT 1
    FROM `workout_sessions` AS session
    JOIN `routine_steps` AS step
      ON step.`id` = NEW.`routine_step_id`
     AND step.`routine_id` = session.`routine_id`
    WHERE session.`id` = NEW.`session_id`
      AND session.`status` = 'active'
      AND (
        NEW.`equipment_id` IS NULL
        OR EXISTS (
          SELECT 1
          FROM `equipment` AS item
          JOIN `equipment_exercises` AS mapping
            ON mapping.`equipment_id` = item.`id`
           AND mapping.`exercise_id` = step.`exercise_id`
          WHERE item.`id` = NEW.`equipment_id`
            AND item.`gym_id` = session.`gym_id`
        )
      )
  )
BEGIN
  SELECT RAISE(ABORT, 'workout_set_invalid');
END;
