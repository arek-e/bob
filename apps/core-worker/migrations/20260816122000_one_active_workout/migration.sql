-- Keep the newest active session for each Owner. Older sessions have an unknown outcome.
-- Mark them abandoned at their start time. Do not invent a completion or workout duration.
UPDATE `workout_sessions` AS `candidate`
SET
  `status` = 'abandoned',
  `finished_at` = COALESCE(`finished_at`, `started_at`)
WHERE `candidate`.`status` = 'active'
  AND EXISTS (
    SELECT 1
    FROM `workout_sessions` AS `keeper`
    WHERE `keeper`.`user_id` = `candidate`.`user_id`
      AND `keeper`.`status` = 'active'
      AND (
        `keeper`.`started_at` > `candidate`.`started_at`
        OR (
          `keeper`.`started_at` = `candidate`.`started_at`
          AND `keeper`.`created_at` > `candidate`.`created_at`
        )
        OR (
          `keeper`.`started_at` = `candidate`.`started_at`
          AND `keeper`.`created_at` = `candidate`.`created_at`
          AND `keeper`.`id` > `candidate`.`id`
        )
      )
  );
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `workout_sessions_one_active_uq`
ON `workout_sessions` (`user_id`)
WHERE `status` = 'active';
