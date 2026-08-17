CREATE TABLE "owner_wake_outbox" (
	"id" text PRIMARY KEY,
	"user_id" text NOT NULL,
	"requested_at" text NOT NULL,
	"state" text NOT NULL,
	"published_at" text,
	"completed_at" text,
	"created_at" text NOT NULL
);
--> statement-breakpoint
CREATE INDEX "owner_wake_outbox_recovery_idx" ON "owner_wake_outbox" ("state","requested_at");--> statement-breakpoint
ALTER TABLE "owner_wake_outbox" ADD CONSTRAINT "owner_wake_outbox_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;