CREATE TABLE "agent_run_outbox" (
	"id" text PRIMARY KEY,
	"run_id" text NOT NULL,
	"kind" text NOT NULL,
	"generation" integer NOT NULL,
	"state" text NOT NULL,
	"available_at" text NOT NULL,
	"claimed_at" text,
	"claim_token" text,
	"claim_expires_at" text,
	"published_at" text,
	"failure_count" integer DEFAULT 0 NOT NULL,
	"created_at" text NOT NULL,
	CONSTRAINT "agent_run_outbox_generation_positive" CHECK ("generation" > 0),
	CONSTRAINT "agent_run_outbox_failure_count_non_negative" CHECK ("failure_count" >= 0)
);
--> statement-breakpoint
ALTER TABLE "agent_run_attempts" ADD COLUMN "fence" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
UPDATE "agent_run_attempts" SET "fence" = "attempt_number";--> statement-breakpoint
ALTER TABLE "agent_run_attempts" ADD COLUMN "worker_id" text;--> statement-breakpoint
ALTER TABLE "agent_run_attempts" ADD COLUMN "lease_expires_at" text;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "origin_type" text;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "origin_id" text;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "idempotency_key" text;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "execution_pool_id" text;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "job_protocol_version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "core_gateway_protocol_version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "checkpoint_loop_version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "dispatch_generation" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "active_attempt_fence" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "control_revision" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "cancellation_requested_at" text;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "cancellation_reason" text;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "outcome_snapshot_json" text;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "outcome_hash" text;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "finalization_completed_at" text;--> statement-breakpoint
ALTER TABLE "agent_runs" ALTER COLUMN "inbound_event_id" DROP NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_run_attempts_sequence_uq" ON "agent_run_attempts" ("run_id","attempt_number");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_run_attempts_fence_uq" ON "agent_run_attempts" ("run_id","fence");--> statement-breakpoint
CREATE INDEX "agent_run_attempts_lease_idx" ON "agent_run_attempts" ("status","lease_expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_run_outbox_generation_uq" ON "agent_run_outbox" ("run_id","kind","generation");--> statement-breakpoint
CREATE INDEX "agent_run_outbox_publish_idx" ON "agent_run_outbox" ("kind","state","available_at");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_runs_owner_idempotency_uq" ON "agent_runs" ("user_id","idempotency_key") WHERE "idempotency_key" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "agent_runs_dispatch_idx" ON "agent_runs" ("status","execution_pool_id","created_at");--> statement-breakpoint
ALTER TABLE "agent_run_attempts" ADD CONSTRAINT "agent_run_attempts_number_positive" CHECK ("attempt_number" > 0);--> statement-breakpoint
ALTER TABLE "agent_run_attempts" ADD CONSTRAINT "agent_run_attempts_fence_non_negative" CHECK ("fence" >= 0);--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_dispatch_generation_positive" CHECK ("dispatch_generation" > 0);--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_active_fence_non_negative" CHECK ("active_attempt_fence" >= 0);--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_control_revision_non_negative" CHECK ("control_revision" >= 0);
