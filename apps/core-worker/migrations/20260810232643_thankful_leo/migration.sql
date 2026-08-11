CREATE TABLE `agent_run_attempts` (
	`id` text PRIMARY KEY,
	`run_id` text NOT NULL,
	`attempt_number` integer NOT NULL,
	`status` text NOT NULL,
	`error_code` text,
	`started_at` text NOT NULL,
	`finished_at` text
);
--> statement-breakpoint
CREATE TABLE `agent_runs` (
	`id` text PRIMARY KEY,
	`user_id` text NOT NULL,
	`inbound_event_id` text NOT NULL,
	`correlation_id` text NOT NULL,
	`input_snapshot_json` text NOT NULL,
	`input_hash` text NOT NULL,
	`status` text NOT NULL,
	`model` text NOT NULL,
	`claimed_at` text,
	`claim_expires_at` text,
	`completed_at` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `audit_events` (
	`id` text PRIMARY KEY,
	`user_id` text,
	`correlation_id` text NOT NULL,
	`action` text NOT NULL,
	`object_type` text NOT NULL,
	`object_id` text NOT NULL,
	`decision_code` text NOT NULL,
	`content_redacted` integer NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `channels` (
	`id` text PRIMARY KEY,
	`user_id` text NOT NULL,
	`provider` text NOT NULL,
	`account_id` text NOT NULL,
	`line_id` text NOT NULL,
	`sender_hash` text NOT NULL,
	`sender_ciphertext` text NOT NULL,
	`sender_iv` text NOT NULL,
	`destination_hash` text NOT NULL,
	`destination_ciphertext` text NOT NULL,
	`destination_iv` text NOT NULL,
	`opted_out_at` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `effect_attempts` (
	`id` text PRIMARY KEY,
	`user_id` text NOT NULL,
	`kind` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`state` text NOT NULL,
	`result_ref` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `inbound_events` (
	`id` text PRIMARY KEY,
	`user_id` text NOT NULL,
	`channel_id` text NOT NULL,
	`message_id` text NOT NULL,
	`account_id` text NOT NULL,
	`line_id` text NOT NULL,
	`provider_message_handle` text NOT NULL,
	`correlation_id` text NOT NULL,
	`enqueued_at` text,
	`claimed_at` text,
	`claim_expires_at` text,
	`processed_at` text,
	`dead_lettered_at` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `message_events` (
	`id` text PRIMARY KEY,
	`message_id` text NOT NULL,
	`kind` text NOT NULL,
	`provider_status` text,
	`occurred_at` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `messages` (
	`id` text PRIMARY KEY,
	`user_id` text NOT NULL,
	`channel_id` text NOT NULL,
	`direction` text NOT NULL,
	`text_ciphertext` text NOT NULL,
	`text_iv` text NOT NULL,
	`data_key_version` integer NOT NULL,
	`occurred_at` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `short_reply_bindings` (
	`id` text PRIMARY KEY,
	`user_id` text NOT NULL,
	`outbound_message_id` text NOT NULL,
	`command` text NOT NULL,
	`target_type` text NOT NULL,
	`target_id` text NOT NULL,
	`inverse_command_json` text,
	`expires_at` text NOT NULL,
	`consumed_at` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `tool_calls` (
	`id` text PRIMARY KEY,
	`run_id` text NOT NULL,
	`tool_call_id` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`tool_name` text NOT NULL,
	`arguments_json` text NOT NULL,
	`result_json` text,
	`status` text NOT NULL,
	`created_at` text NOT NULL,
	`completed_at` text
);
--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY,
	`time_zone` text NOT NULL,
	`wrapped_data_key` text,
	`wrapped_data_key_iv` text,
	`data_key_version` integer,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `delivery_attempts` (
	`id` text PRIMARY KEY,
	`outbox_id` text NOT NULL,
	`attempt_number` integer NOT NULL,
	`state` text NOT NULL,
	`provider_message_handle` text,
	`error_code` text,
	`started_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `outbox_messages` (
	`id` text PRIMARY KEY,
	`user_id` text NOT NULL,
	`channel_id` text NOT NULL,
	`message_id` text NOT NULL,
	`reason_code` text NOT NULL,
	`correlation_id` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`state` text NOT NULL,
	`enqueued_at` text,
	`claimed_at` text,
	`claim_expires_at` text,
	`completed_at` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `provider_events` (
	`id` text PRIMARY KEY,
	`provider` text NOT NULL,
	`provider_message_handle` text NOT NULL,
	`provider_status` text NOT NULL,
	`provider_event_key` text NOT NULL,
	`correlation_id` text NOT NULL,
	`occurred_at` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `attachments` (
	`id` text PRIMARY KEY,
	`user_id` text NOT NULL,
	`journal_entry_id` text,
	`r2_key` text NOT NULL,
	`content_type` text NOT NULL,
	`byte_length` integer NOT NULL,
	`content_hash` text NOT NULL,
	`data_key_version` integer NOT NULL,
	`deleted_at` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `journal_entries` (
	`id` text PRIMARY KEY,
	`user_id` text NOT NULL,
	`text_ciphertext` text NOT NULL,
	`text_iv` text NOT NULL,
	`data_key_version` integer NOT NULL,
	`tags_json` text NOT NULL,
	`approved_summary` text,
	`content_hash` text NOT NULL,
	`redacted_at` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `journal_handoffs` (
	`id` text PRIMARY KEY,
	`user_id` text NOT NULL,
	`expires_at` text NOT NULL,
	`consumed_at` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `fact_evidence` (
	`id` text PRIMARY KEY,
	`revision_id` text NOT NULL,
	`source_type` text NOT NULL,
	`source_id` text NOT NULL,
	`evidence_role` text NOT NULL,
	`excerpt_hash` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `fact_relations` (
	`id` text PRIMARY KEY,
	`from_revision_id` text NOT NULL,
	`to_revision_id` text NOT NULL,
	`relation` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `fact_revisions` (
	`id` text PRIMARY KEY,
	`fact_id` text NOT NULL,
	`value_json` text NOT NULL,
	`canonical_text_ciphertext` text NOT NULL,
	`canonical_text_iv` text NOT NULL,
	`data_key_version` integer NOT NULL,
	`assertion_kind` text NOT NULL,
	`origin_class` text NOT NULL,
	`observed_at` text NOT NULL,
	`valid_from` text,
	`valid_to` text,
	`extraction_confidence` integer NOT NULL,
	`importance` integer NOT NULL,
	`verification_status` text NOT NULL,
	`sensitivity` text NOT NULL,
	`model_eligible` integer NOT NULL,
	`channel_eligible` integer NOT NULL,
	`supersedes_revision_id` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `facts` (
	`id` text PRIMARY KEY,
	`user_id` text NOT NULL,
	`scope` text NOT NULL,
	`key` text NOT NULL,
	`current_revision_id` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `memory_candidates` (
	`id` text PRIMARY KEY,
	`user_id` text NOT NULL,
	`scope` text NOT NULL,
	`key` text NOT NULL,
	`proposed_value_json` text NOT NULL,
	`canonical_text_ciphertext` text NOT NULL,
	`canonical_text_iv` text NOT NULL,
	`origin_class` text NOT NULL,
	`source_type` text NOT NULL,
	`source_id` text NOT NULL,
	`extraction_confidence` integer NOT NULL,
	`sensitivity` text NOT NULL,
	`status` text NOT NULL,
	`created_at` text NOT NULL,
	`reviewed_at` text
);
--> statement-breakpoint
CREATE TABLE `search_documents` (
	`id` text PRIMARY KEY,
	`user_id` text NOT NULL,
	`source_type` text NOT NULL,
	`source_id` text NOT NULL,
	`text` text NOT NULL,
	`source_label` text NOT NULL,
	`occurred_at` text,
	`importance` integer NOT NULL,
	`sensitivity` text NOT NULL,
	`model_eligible` integer NOT NULL,
	`channel_eligible` integer NOT NULL,
	`deleted_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `reminder_actions` (
	`id` text PRIMARY KEY,
	`reminder_id` text NOT NULL,
	`occurrence_id` text,
	`action` text NOT NULL,
	`actor` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `reminder_occurrences` (
	`id` text PRIMARY KEY,
	`reminder_id` text NOT NULL,
	`sequence` integer NOT NULL,
	`intended_due_at` text NOT NULL,
	`local_display_time` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`state` text NOT NULL,
	`claim_token` text,
	`claimed_at` text,
	`claim_expires_at` text,
	`response_deadline_at` text,
	`snoozed_to_occurrence_id` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `reminders` (
	`id` text PRIMARY KEY,
	`user_id` text NOT NULL,
	`source_message_id` text NOT NULL,
	`original_wording_ciphertext` text NOT NULL,
	`original_wording_iv` text NOT NULL,
	`display_text_ciphertext` text NOT NULL,
	`display_text_iv` text NOT NULL,
	`sms_safe_text_ciphertext` text NOT NULL,
	`sms_safe_text_iv` text NOT NULL,
	`data_key_version` integer NOT NULL,
	`sensitivity` text NOT NULL,
	`schedule_kind` text NOT NULL,
	`local_start_date` text NOT NULL,
	`local_start_time` text NOT NULL,
	`time_zone` text NOT NULL,
	`rrule` text,
	`next_due_at` text,
	`quiet_hours_behavior` text NOT NULL,
	`requires_acknowledgment` integer NOT NULL,
	`response_deadline_minutes` integer NOT NULL,
	`repeat_policy` text NOT NULL,
	`max_attempts` integer NOT NULL,
	`channel_id` text NOT NULL,
	`state` text NOT NULL,
	`schedule_revision` integer NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `scheduler_outbox` (
	`id` text PRIMARY KEY,
	`user_id` text NOT NULL,
	`reminder_id` text NOT NULL,
	`schedule_revision` integer NOT NULL,
	`command` text NOT NULL,
	`enqueued_at` text,
	`processed_at` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `equipment` (
	`id` text PRIMARY KEY,
	`gym_id` text NOT NULL,
	`name` text NOT NULL,
	`identifier` text,
	`notes` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `equipment_exercises` (
	`id` text PRIMARY KEY,
	`equipment_id` text NOT NULL,
	`exercise_id` text NOT NULL,
	`user_approved_at` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `exercises` (
	`id` text PRIMARY KEY,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`instructions` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `gyms` (
	`id` text PRIMARY KEY,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `routine_steps` (
	`id` text PRIMARY KEY,
	`routine_id` text NOT NULL,
	`exercise_id` text NOT NULL,
	`position` integer NOT NULL,
	`target_sets` integer,
	`target_reps` integer,
	`notes` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `routines` (
	`id` text PRIMARY KEY,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`revision` integer NOT NULL,
	`approved_at` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `workout_sessions` (
	`id` text PRIMARY KEY,
	`user_id` text NOT NULL,
	`routine_id` text NOT NULL,
	`gym_id` text,
	`status` text NOT NULL,
	`started_at` text NOT NULL,
	`finished_at` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `workout_sets` (
	`id` text PRIMARY KEY,
	`session_id` text NOT NULL,
	`routine_step_id` text NOT NULL,
	`equipment_id` text,
	`sequence` integer NOT NULL,
	`repetitions` integer NOT NULL,
	`weight_grams` integer,
	`notes` text,
	`pain_reported` integer NOT NULL,
	`machine_confusion` integer NOT NULL,
	`logged_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agent_runs_inbound_uq` ON `agent_runs` (`inbound_event_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `channels_provider_address_uq` ON `channels` (`provider`,`account_id`,`line_id`,`sender_hash`);--> statement-breakpoint
CREATE UNIQUE INDEX `effect_attempts_idempotency_uq` ON `effect_attempts` (`idempotency_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `inbound_events_provider_uq` ON `inbound_events` (`account_id`,`line_id`,`provider_message_handle`);--> statement-breakpoint
CREATE INDEX `inbound_events_work_idx` ON `inbound_events` (`processed_at`,`claim_expires_at`);--> statement-breakpoint
CREATE INDEX `message_events_message_idx` ON `message_events` (`message_id`,`occurred_at`);--> statement-breakpoint
CREATE INDEX `messages_conversation_idx` ON `messages` (`channel_id`,`occurred_at`);--> statement-breakpoint
CREATE INDEX `short_reply_pending_idx` ON `short_reply_bindings` (`user_id`,`command`,`expires_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `tool_calls_run_call_uq` ON `tool_calls` (`run_id`,`tool_call_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `tool_calls_idempotency_uq` ON `tool_calls` (`idempotency_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `delivery_attempt_sequence_uq` ON `delivery_attempts` (`outbox_id`,`attempt_number`);--> statement-breakpoint
CREATE UNIQUE INDEX `delivery_provider_handle_uq` ON `delivery_attempts` (`provider_message_handle`);--> statement-breakpoint
CREATE UNIQUE INDEX `outbox_idempotency_uq` ON `outbox_messages` (`idempotency_key`);--> statement-breakpoint
CREATE INDEX `outbox_publish_idx` ON `outbox_messages` (`enqueued_at`,`state`);--> statement-breakpoint
CREATE UNIQUE INDEX `provider_events_key_uq` ON `provider_events` (`provider`,`provider_event_key`);--> statement-breakpoint
CREATE INDEX `provider_events_message_idx` ON `provider_events` (`provider_message_handle`,`occurred_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `attachments_r2_key_uq` ON `attachments` (`r2_key`);--> statement-breakpoint
CREATE INDEX `journal_entries_date_idx` ON `journal_entries` (`user_id`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `fact_evidence_source_uq` ON `fact_evidence` (`revision_id`,`source_type`,`source_id`);--> statement-breakpoint
CREATE INDEX `fact_revisions_fact_idx` ON `fact_revisions` (`fact_id`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `facts_identity_uq` ON `facts` (`user_id`,`scope`,`key`);--> statement-breakpoint
CREATE UNIQUE INDEX `search_documents_source_uq` ON `search_documents` (`source_type`,`source_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `reminder_actions_idempotency_uq` ON `reminder_actions` (`idempotency_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `reminder_occurrences_idempotency_uq` ON `reminder_occurrences` (`idempotency_key`);--> statement-breakpoint
CREATE INDEX `reminder_occurrences_due_idx` ON `reminder_occurrences` (`state`,`intended_due_at`);--> statement-breakpoint
CREATE INDEX `reminder_occurrences_claim_idx` ON `reminder_occurrences` (`claim_expires_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `scheduler_revision_uq` ON `scheduler_outbox` (`reminder_id`,`schedule_revision`);--> statement-breakpoint
CREATE INDEX `scheduler_publish_idx` ON `scheduler_outbox` (`enqueued_at`,`processed_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `equipment_gym_identifier_uq` ON `equipment` (`gym_id`,`identifier`);--> statement-breakpoint
CREATE UNIQUE INDEX `equipment_exercises_uq` ON `equipment_exercises` (`equipment_id`,`exercise_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `routine_steps_position_uq` ON `routine_steps` (`routine_id`,`position`);--> statement-breakpoint
CREATE INDEX `workout_sessions_history_idx` ON `workout_sessions` (`user_id`,`started_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `workout_sets_sequence_uq` ON `workout_sets` (`session_id`,`routine_step_id`,`sequence`);