CREATE TABLE "auth_account" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid(),
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp with time zone,
	"refresh_token_expires_at" timestamp with time zone,
	"scope" text,
	"password" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auth_rate_limit" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid(),
	"key" text NOT NULL,
	"count" integer NOT NULL,
	"last_request" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auth_session" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid(),
	"expires_at" timestamp with time zone NOT NULL,
	"token" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"user_id" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auth_user" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid(),
	"name" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean NOT NULL,
	"image" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auth_verification" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid(),
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "operational_alerts" (
	"id" text PRIMARY KEY,
	"user_id" text NOT NULL,
	"code" text NOT NULL,
	"object_type" text NOT NULL,
	"object_id" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"state" text NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	"resolved_at" text
);
--> statement-breakpoint
CREATE TABLE "artifact_revisions" (
	"artifact_id" text NOT NULL,
	"revision" integer NOT NULL,
	"content_ciphertext" text NOT NULL,
	"content_iv" text NOT NULL,
	"rendered_text_ciphertext" text NOT NULL,
	"rendered_text_iv" text NOT NULL,
	"data_key_version" integer NOT NULL,
	"source_ids_json" text NOT NULL,
	"created_by_run_id" text NOT NULL,
	"created_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "artifacts" (
	"id" text PRIMARY KEY,
	"user_id" text NOT NULL,
	"channel_id" text NOT NULL,
	"kind" text NOT NULL,
	"current_revision" integer NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "external_connections" (
	"id" text PRIMARY KEY,
	"owner_id" text NOT NULL,
	"provider" text NOT NULL,
	"integration_id" text NOT NULL,
	"connection_id" text NOT NULL,
	"status" text NOT NULL,
	"connected_at" text NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_run_attempts" (
	"id" text PRIMARY KEY,
	"run_id" text NOT NULL,
	"attempt_number" integer NOT NULL,
	"status" text NOT NULL,
	"error_code" text,
	"started_at" text NOT NULL,
	"finished_at" text
);
--> statement-breakpoint
CREATE TABLE "agent_run_operations" (
	"id" text PRIMARY KEY,
	"run_id" text NOT NULL,
	"sequence" integer NOT NULL,
	"kind" text NOT NULL,
	"loop_version" integer NOT NULL,
	"payload_ciphertext" text NOT NULL,
	"payload_iv" text NOT NULL,
	"payload_hash" text NOT NULL,
	"data_key_version" integer NOT NULL,
	"created_by_attempt_id" text NOT NULL,
	"created_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_runs" (
	"id" text PRIMARY KEY,
	"user_id" text NOT NULL,
	"inbound_event_id" text NOT NULL,
	"turn_id" text,
	"turn_revision" integer,
	"target_message_id" text,
	"correlation_id" text NOT NULL,
	"input_snapshot_json" text NOT NULL,
	"input_hash" text NOT NULL,
	"status" text NOT NULL,
	"model" text NOT NULL,
	"claimed_at" text,
	"claim_expires_at" text,
	"active_attempt_id" text,
	"completed_at" text,
	"created_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_events" (
	"id" text PRIMARY KEY,
	"user_id" text,
	"correlation_id" text NOT NULL,
	"action" text NOT NULL,
	"object_type" text NOT NULL,
	"object_id" text NOT NULL,
	"decision_code" text NOT NULL,
	"content_redacted" boolean NOT NULL,
	"created_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "channels" (
	"id" text PRIMARY KEY,
	"user_id" text NOT NULL,
	"provider" text NOT NULL,
	"account_id" text NOT NULL,
	"line_id" text NOT NULL,
	"sender_hash" text NOT NULL,
	"sender_ciphertext" text NOT NULL,
	"sender_iv" text NOT NULL,
	"destination_hash" text NOT NULL,
	"destination_ciphertext" text NOT NULL,
	"destination_iv" text NOT NULL,
	"opted_out_at" text,
	"opted_in_at" text,
	"created_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "conversation_turn_messages" (
	"turn_id" text NOT NULL,
	"inbound_event_id" text NOT NULL,
	"message_id" text NOT NULL,
	"ordinal" integer NOT NULL,
	"revision" integer NOT NULL,
	"traceparent" text,
	"created_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "conversation_turns" (
	"id" text PRIMARY KEY,
	"user_id" text NOT NULL,
	"channel_id" text NOT NULL,
	"status" text NOT NULL,
	"revision" integer NOT NULL,
	"context_eligible" boolean,
	"latest_inbound_event_id" text NOT NULL,
	"latest_message_id" text NOT NULL,
	"active_run_id" text,
	"active_run_revision" integer,
	"claimed_revision" integer,
	"claimed_at" text,
	"claim_expires_at" text,
	"quiet_until" text NOT NULL,
	"burst_expires_at" text NOT NULL,
	"reply_outbox_id" text,
	"mutation_idempotency_key" text,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	"replied_at" text
);
--> statement-breakpoint
CREATE TABLE "effect_attempts" (
	"id" text PRIMARY KEY,
	"user_id" text NOT NULL,
	"kind" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"state" text NOT NULL,
	"result_ref" text,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "inbound_events" (
	"id" text PRIMARY KEY,
	"user_id" text NOT NULL,
	"channel_id" text NOT NULL,
	"message_id" text NOT NULL,
	"account_id" text NOT NULL,
	"line_id" text NOT NULL,
	"provider_message_handle" text NOT NULL,
	"reply_to_provider_message_handle" text,
	"service" text DEFAULT 'unknown' NOT NULL,
	"is_group" boolean DEFAULT false NOT NULL,
	"reaction_claimed_at" text,
	"correlation_id" text NOT NULL,
	"enqueued_at" text,
	"claimed_at" text,
	"claim_expires_at" text,
	"processed_at" text,
	"dead_lettered_at" text,
	"recovery_count" integer DEFAULT 0 NOT NULL,
	"created_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "message_events" (
	"id" text PRIMARY KEY,
	"message_id" text NOT NULL,
	"kind" text NOT NULL,
	"provider_status" text,
	"occurred_at" text NOT NULL,
	"created_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" text PRIMARY KEY,
	"user_id" text NOT NULL,
	"channel_id" text NOT NULL,
	"direction" text NOT NULL,
	"text_ciphertext" text NOT NULL,
	"text_iv" text NOT NULL,
	"data_key_version" integer NOT NULL,
	"occurred_at" text NOT NULL,
	"created_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "short_reply_bindings" (
	"id" text PRIMARY KEY,
	"user_id" text NOT NULL,
	"outbound_message_id" text NOT NULL,
	"command" text NOT NULL,
	"target_type" text NOT NULL,
	"target_id" text NOT NULL,
	"inverse_command_json" text,
	"expires_at" text NOT NULL,
	"consumed_at" text,
	"created_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tool_calls" (
	"id" text PRIMARY KEY,
	"run_id" text NOT NULL,
	"tool_call_id" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"owner_id" text,
	"tool_name" text NOT NULL,
	"command_hash" text,
	"arguments_json" text NOT NULL,
	"result_json" text,
	"status" text NOT NULL,
	"claim_token" text,
	"claimed_at" text,
	"claim_expires_at" text,
	"attempt_number" integer DEFAULT 0 NOT NULL,
	"created_at" text NOT NULL,
	"completed_at" text
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY,
	"time_zone" text NOT NULL,
	"locale" text DEFAULT 'en' NOT NULL,
	"hour_cycle" text DEFAULT 'auto' NOT NULL,
	"wrapped_data_key" text,
	"wrapped_data_key_iv" text,
	"data_key_version" integer,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "delivery_attempts" (
	"id" text PRIMARY KEY,
	"outbox_id" text NOT NULL,
	"attempt_number" integer NOT NULL,
	"state" text NOT NULL,
	"provider_message_handle" text,
	"payload_fingerprint" text,
	"error_code" text,
	"started_at" text NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "outbox_messages" (
	"id" text PRIMARY KEY,
	"user_id" text NOT NULL,
	"channel_id" text NOT NULL,
	"message_id" text NOT NULL,
	"reason_code" text NOT NULL,
	"correlation_id" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"action_target_type" text,
	"action_target_id" text,
	"reply_to_provider_message_handle" text,
	"conversation_turn_id" text,
	"conversation_turn_revision" integer,
	"depends_on_outbox_id" text,
	"artifact_id" text,
	"artifact_revision" integer,
	"state" text NOT NULL,
	"enqueued_at" text,
	"claimed_at" text,
	"claim_token" text,
	"claim_expires_at" text,
	"dead_lettered_at" text,
	"dispatch_generation" integer DEFAULT 0 NOT NULL,
	"recovery_count" integer DEFAULT 0 NOT NULL,
	"completed_at" text,
	"created_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "provider_events" (
	"id" text PRIMARY KEY,
	"provider" text NOT NULL,
	"provider_message_handle" text NOT NULL,
	"provider_status" text NOT NULL,
	"provider_event_key" text NOT NULL,
	"correlation_id" text NOT NULL,
	"occurred_at" text NOT NULL,
	"created_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "attachments" (
	"id" text PRIMARY KEY,
	"user_id" text NOT NULL,
	"journal_entry_id" text,
	"r2_key" text NOT NULL,
	"content_type" text NOT NULL,
	"byte_length" integer NOT NULL,
	"content_hash" text NOT NULL,
	"data_key_version" integer NOT NULL,
	"deleted_at" text,
	"created_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "journal_entries" (
	"id" text PRIMARY KEY,
	"user_id" text NOT NULL,
	"handoff_id" text NOT NULL,
	"text_ciphertext" text NOT NULL,
	"text_iv" text NOT NULL,
	"data_key_version" integer NOT NULL,
	"tags_json" text NOT NULL,
	"approved_summary" text,
	"content_hash" text NOT NULL,
	"redacted_at" text,
	"created_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "journal_handoffs" (
	"id" text PRIMARY KEY,
	"user_id" text NOT NULL,
	"expires_at" text NOT NULL,
	"consumed_at" text,
	"created_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fact_evidence" (
	"id" text PRIMARY KEY,
	"revision_id" text NOT NULL,
	"source_type" text NOT NULL,
	"source_id" text NOT NULL,
	"source_label" text,
	"source_occurred_at" text,
	"evidence_role" text NOT NULL,
	"excerpt_hash" text NOT NULL,
	"created_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fact_relations" (
	"id" text PRIMARY KEY,
	"from_revision_id" text NOT NULL,
	"to_revision_id" text NOT NULL,
	"relation" text NOT NULL,
	"created_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fact_revisions" (
	"id" text PRIMARY KEY,
	"fact_id" text NOT NULL,
	"value_envelope" text NOT NULL,
	"value_json" text DEFAULT 'null' NOT NULL,
	"value_ciphertext" text,
	"value_iv" text,
	"canonical_text_ciphertext" text NOT NULL,
	"canonical_text_iv" text NOT NULL,
	"data_key_version" integer NOT NULL,
	"assertion_kind" text NOT NULL,
	"origin_class" text NOT NULL,
	"observed_at" text NOT NULL,
	"valid_from" text,
	"valid_to" text,
	"extraction_confidence" integer NOT NULL,
	"importance" integer NOT NULL,
	"verification_status" text NOT NULL,
	"sensitivity" text NOT NULL,
	"model_eligible" boolean NOT NULL,
	"channel_eligible" boolean NOT NULL,
	"supersedes_revision_id" text,
	"created_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "facts" (
	"id" text PRIMARY KEY,
	"user_id" text NOT NULL,
	"scope" text NOT NULL,
	"key" text NOT NULL,
	"current_revision_id" text,
	"created_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memory_candidates" (
	"id" text PRIMARY KEY,
	"user_id" text NOT NULL,
	"scope" text NOT NULL,
	"key" text NOT NULL,
	"proposed_value_envelope" text NOT NULL,
	"proposed_value_json" text DEFAULT 'null' NOT NULL,
	"proposed_value_ciphertext" text,
	"proposed_value_iv" text,
	"canonical_text_ciphertext" text NOT NULL,
	"canonical_text_iv" text NOT NULL,
	"memory_class" text DEFAULT 'owner_fact' NOT NULL,
	"origin_class" text NOT NULL,
	"source_type" text NOT NULL,
	"source_id" text NOT NULL,
	"source_label" text,
	"source_occurred_at" text,
	"source_content_hash" text,
	"extraction_confidence" integer NOT NULL,
	"sensitivity" text NOT NULL,
	"status" text NOT NULL,
	"review_claim_action" text,
	"review_claim_id" text,
	"review_claim_expires_at" text,
	"review_result_id" text,
	"created_at" text NOT NULL,
	"reviewed_at" text
);
--> statement-breakpoint
CREATE TABLE "memory_review_claim_guards" (
	"claim_id" text PRIMARY KEY
);
--> statement-breakpoint
CREATE TABLE "agent_usage" (
	"run_id" text PRIMARY KEY,
	"user_id" text NOT NULL,
	"correlation_id" text NOT NULL,
	"feature" text NOT NULL,
	"workflow" text NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"status" text NOT NULL,
	"input_tokens" integer NOT NULL,
	"output_tokens" integer NOT NULL,
	"tool_calls" integer NOT NULL,
	"duration_ms" integer NOT NULL,
	"occurred_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reminder_actions" (
	"id" text PRIMARY KEY,
	"reminder_id" text NOT NULL,
	"occurrence_id" text,
	"action" text NOT NULL,
	"actor" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"created_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reminder_occurrences" (
	"id" text PRIMARY KEY,
	"reminder_id" text NOT NULL,
	"sequence" integer NOT NULL,
	"intended_due_at" text NOT NULL,
	"local_display_time" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"state" text NOT NULL,
	"claim_token" text,
	"claimed_at" text,
	"claim_expires_at" text,
	"response_deadline_at" text,
	"snoozed_to_occurrence_id" text,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reminders" (
	"id" text PRIMARY KEY,
	"user_id" text NOT NULL,
	"source_message_id" text NOT NULL,
	"original_wording_ciphertext" text NOT NULL,
	"original_wording_iv" text NOT NULL,
	"display_text_ciphertext" text NOT NULL,
	"display_text_iv" text NOT NULL,
	"sms_safe_text_ciphertext" text NOT NULL,
	"sms_safe_text_iv" text NOT NULL,
	"data_key_version" integer NOT NULL,
	"sensitivity" text NOT NULL,
	"schedule_kind" text NOT NULL,
	"local_start_date" text NOT NULL,
	"local_start_time" text NOT NULL,
	"time_zone" text NOT NULL,
	"rrule" text,
	"next_due_at" text,
	"quiet_hours_behavior" text NOT NULL,
	"requires_acknowledgment" boolean NOT NULL,
	"response_deadline_minutes" integer NOT NULL,
	"repeat_policy" text NOT NULL,
	"max_attempts" integer NOT NULL,
	"channel_id" text NOT NULL,
	"state" text NOT NULL,
	"schedule_revision" integer NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "scheduler_outbox" (
	"id" text PRIMARY KEY,
	"user_id" text NOT NULL,
	"reminder_id" text NOT NULL,
	"schedule_revision" integer NOT NULL,
	"command" text NOT NULL,
	"enqueued_at" text,
	"processed_at" text,
	"created_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "search_documents" (
	"id" text PRIMARY KEY,
	"user_id" text NOT NULL,
	"source_type" text NOT NULL,
	"source_id" text NOT NULL,
	"memory_class" text DEFAULT 'owner_episode' NOT NULL,
	"text" text NOT NULL,
	"search_text" text DEFAULT '' NOT NULL,
	"content_hash" text,
	"source_label" text NOT NULL,
	"occurred_at" text,
	"conflict_key" text,
	"valid_from" text,
	"valid_to" text,
	"importance" integer NOT NULL,
	"sensitivity" text NOT NULL,
	"model_eligible" boolean NOT NULL,
	"channel_eligible" boolean NOT NULL,
	"deleted_at" text,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "equipment" (
	"id" text PRIMARY KEY,
	"gym_id" text NOT NULL,
	"name" text NOT NULL,
	"identifier" text,
	"notes" text,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "equipment_exercises" (
	"id" text PRIMARY KEY,
	"equipment_id" text NOT NULL,
	"exercise_id" text NOT NULL,
	"user_approved_at" text NOT NULL,
	"created_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "exercises" (
	"id" text PRIMARY KEY,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"instructions" text,
	"created_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "gyms" (
	"id" text PRIMARY KEY,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "routine_steps" (
	"id" text PRIMARY KEY,
	"routine_id" text NOT NULL,
	"exercise_id" text NOT NULL,
	"position" integer NOT NULL,
	"target_sets" integer,
	"target_reps" integer,
	"notes" text,
	"created_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "routines" (
	"id" text PRIMARY KEY,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"revision" integer NOT NULL,
	"approved_at" text NOT NULL,
	"approval_source_type" text NOT NULL,
	"approval_source_id" text NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "training_proposals" (
	"id" text PRIMARY KEY,
	"user_id" text NOT NULL,
	"run_id" text NOT NULL,
	"tool_call_id" text NOT NULL,
	"tool_name" text NOT NULL,
	"command_idempotency_key" text NOT NULL,
	"proposal_hash" text NOT NULL,
	"arguments_json" text NOT NULL,
	"source_message_id" text NOT NULL,
	"status" text NOT NULL,
	"result_json" text,
	"approval_idempotency_key" text,
	"created_at" text NOT NULL,
	"approved_at" text,
	"applied_at" text
);
--> statement-breakpoint
CREATE TABLE "workout_sessions" (
	"id" text PRIMARY KEY,
	"user_id" text NOT NULL,
	"routine_id" text NOT NULL,
	"gym_id" text,
	"status" text NOT NULL,
	"started_at" text NOT NULL,
	"finished_at" text,
	"created_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workout_sets" (
	"id" text PRIMARY KEY,
	"session_id" text NOT NULL,
	"routine_step_id" text NOT NULL,
	"equipment_id" text,
	"sequence" integer NOT NULL,
	"repetitions" integer NOT NULL,
	"weight_grams" integer,
	"notes" text,
	"pain_reported" boolean NOT NULL,
	"machine_confusion" boolean NOT NULL,
	"logged_at" text NOT NULL
);
--> statement-breakpoint
CREATE INDEX "auth_account_user_id_idx" ON "auth_account" ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "auth_rate_limit_key_uq" ON "auth_rate_limit" ("key");--> statement-breakpoint
CREATE UNIQUE INDEX "auth_session_token_uq" ON "auth_session" ("token");--> statement-breakpoint
CREATE INDEX "auth_session_user_id_idx" ON "auth_session" ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "auth_user_email_uq" ON "auth_user" ("email");--> statement-breakpoint
CREATE INDEX "auth_verification_identifier_idx" ON "auth_verification" ("identifier");--> statement-breakpoint
CREATE UNIQUE INDEX "operational_alerts_idempotency_uq" ON "operational_alerts" ("idempotency_key");--> statement-breakpoint
CREATE INDEX "operational_alerts_owner_state_idx" ON "operational_alerts" ("user_id","state","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "artifact_revisions_identity_uq" ON "artifact_revisions" ("artifact_id","revision");--> statement-breakpoint
CREATE INDEX "artifact_revisions_run_idx" ON "artifact_revisions" ("created_by_run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "artifacts_owner_channel_kind_uq" ON "artifacts" ("user_id","channel_id","kind");--> statement-breakpoint
CREATE INDEX "artifacts_latest_idx" ON "artifacts" ("user_id","channel_id","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "external_connections_owner_provider_uq" ON "external_connections" ("owner_id","provider");--> statement-breakpoint
CREATE UNIQUE INDEX "external_connections_nango_uq" ON "external_connections" ("integration_id","connection_id");--> statement-breakpoint
CREATE INDEX "external_connections_owner_idx" ON "external_connections" ("owner_id");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_run_operations_sequence_uq" ON "agent_run_operations" ("run_id","sequence");--> statement-breakpoint
CREATE INDEX "agent_run_operations_order_idx" ON "agent_run_operations" ("run_id","sequence");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_runs_legacy_inbound_uq" ON "agent_runs" ("inbound_event_id") WHERE "turn_id" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_runs_turn_revision_uq" ON "agent_runs" ("turn_id","turn_revision") WHERE "turn_id" IS NOT NULL AND "turn_revision" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "channels_provider_address_uq" ON "channels" ("provider","account_id","line_id","sender_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "conversation_turn_messages_event_uq" ON "conversation_turn_messages" ("inbound_event_id");--> statement-breakpoint
CREATE UNIQUE INDEX "conversation_turn_messages_ordinal_uq" ON "conversation_turn_messages" ("turn_id","ordinal");--> statement-breakpoint
CREATE INDEX "conversation_turn_messages_order_idx" ON "conversation_turn_messages" ("turn_id","ordinal");--> statement-breakpoint
CREATE UNIQUE INDEX "conversation_turns_open_uq" ON "conversation_turns" ("user_id","channel_id") WHERE "status" <> 'replied';--> statement-breakpoint
CREATE INDEX "conversation_turns_channel_status_idx" ON "conversation_turns" ("user_id","channel_id","status","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "effect_attempts_idempotency_uq" ON "effect_attempts" ("idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "inbound_events_provider_uq" ON "inbound_events" ("account_id","line_id","provider_message_handle");--> statement-breakpoint
CREATE INDEX "inbound_events_work_idx" ON "inbound_events" ("processed_at","claim_expires_at");--> statement-breakpoint
CREATE INDEX "message_events_message_idx" ON "message_events" ("message_id","occurred_at");--> statement-breakpoint
CREATE INDEX "messages_conversation_idx" ON "messages" ("channel_id","occurred_at");--> statement-breakpoint
CREATE INDEX "short_reply_pending_idx" ON "short_reply_bindings" ("user_id","command","expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "short_reply_target_uq" ON "short_reply_bindings" ("outbound_message_id","command","target_type","target_id");--> statement-breakpoint
CREATE UNIQUE INDEX "tool_calls_run_call_uq" ON "tool_calls" ("run_id","tool_call_id");--> statement-breakpoint
CREATE UNIQUE INDEX "tool_calls_idempotency_uq" ON "tool_calls" ("idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "delivery_attempt_sequence_uq" ON "delivery_attempts" ("outbox_id","attempt_number");--> statement-breakpoint
CREATE UNIQUE INDEX "delivery_provider_handle_uq" ON "delivery_attempts" ("provider_message_handle");--> statement-breakpoint
CREATE UNIQUE INDEX "outbox_idempotency_uq" ON "outbox_messages" ("idempotency_key");--> statement-breakpoint
CREATE INDEX "outbox_publish_idx" ON "outbox_messages" ("enqueued_at","state");--> statement-breakpoint
CREATE INDEX "outbox_dependency_idx" ON "outbox_messages" ("depends_on_outbox_id","state");--> statement-breakpoint
CREATE UNIQUE INDEX "provider_events_key_uq" ON "provider_events" ("provider","provider_event_key");--> statement-breakpoint
CREATE INDEX "provider_events_message_idx" ON "provider_events" ("provider_message_handle","occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX "attachments_r2_key_uq" ON "attachments" ("r2_key");--> statement-breakpoint
CREATE INDEX "journal_entries_date_idx" ON "journal_entries" ("user_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "journal_entries_handoff_uq" ON "journal_entries" ("handoff_id");--> statement-breakpoint
CREATE UNIQUE INDEX "fact_evidence_source_uq" ON "fact_evidence" ("revision_id","source_type","source_id");--> statement-breakpoint
CREATE INDEX "fact_revisions_fact_idx" ON "fact_revisions" ("fact_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "facts_identity_uq" ON "facts" ("user_id","scope","key");--> statement-breakpoint
CREATE INDEX "memory_candidates_review_claim_idx" ON "memory_candidates" ("status","review_claim_expires_at");--> statement-breakpoint
CREATE INDEX "agent_usage_owner_time_idx" ON "agent_usage" ("user_id","occurred_at");--> statement-breakpoint
CREATE INDEX "agent_usage_feature_workflow_idx" ON "agent_usage" ("user_id","feature","workflow","occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX "reminder_actions_idempotency_uq" ON "reminder_actions" ("idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "reminder_occurrences_idempotency_uq" ON "reminder_occurrences" ("idempotency_key");--> statement-breakpoint
CREATE INDEX "reminder_occurrences_due_idx" ON "reminder_occurrences" ("state","intended_due_at");--> statement-breakpoint
CREATE INDEX "reminder_occurrences_claim_idx" ON "reminder_occurrences" ("claim_expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "scheduler_revision_uq" ON "scheduler_outbox" ("reminder_id","schedule_revision");--> statement-breakpoint
CREATE INDEX "scheduler_publish_idx" ON "scheduler_outbox" ("enqueued_at","processed_at");--> statement-breakpoint
CREATE UNIQUE INDEX "search_documents_source_uq" ON "search_documents" ("source_type","source_id");--> statement-breakpoint
CREATE INDEX "search_documents_owner_validity_idx" ON "search_documents" ("user_id","deleted_at","valid_from","valid_to");--> statement-breakpoint
CREATE UNIQUE INDEX "equipment_gym_identifier_uq" ON "equipment" ("gym_id","identifier");--> statement-breakpoint
CREATE UNIQUE INDEX "equipment_exercises_uq" ON "equipment_exercises" ("equipment_id","exercise_id");--> statement-breakpoint
CREATE UNIQUE INDEX "routine_steps_position_uq" ON "routine_steps" ("routine_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "training_proposals_run_call_uq" ON "training_proposals" ("run_id","tool_call_id");--> statement-breakpoint
CREATE UNIQUE INDEX "training_proposals_hash_uq" ON "training_proposals" ("proposal_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "training_proposals_owner_approval_uq" ON "training_proposals" ("user_id","approval_idempotency_key");--> statement-breakpoint
CREATE INDEX "training_proposals_owner_state_idx" ON "training_proposals" ("user_id","status","created_at");--> statement-breakpoint
CREATE INDEX "workout_sessions_history_idx" ON "workout_sessions" ("user_id","started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "workout_sessions_one_active_uq" ON "workout_sessions" ("user_id") WHERE "status" = 'active';--> statement-breakpoint
CREATE UNIQUE INDEX "workout_sets_sequence_uq" ON "workout_sets" ("session_id","routine_step_id","sequence");--> statement-breakpoint
ALTER TABLE "auth_account" ADD CONSTRAINT "auth_account_user_id_auth_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth_user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "auth_session" ADD CONSTRAINT "auth_session_user_id_auth_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth_user"("id") ON DELETE CASCADE;