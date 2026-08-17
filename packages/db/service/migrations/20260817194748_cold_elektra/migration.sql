CREATE TABLE "message_attachments" (
	"id" text PRIMARY KEY,
	"user_id" text NOT NULL,
	"message_id" text NOT NULL,
	"inbound_event_id" text NOT NULL,
	"ordinal" integer NOT NULL,
	"object_key" text NOT NULL,
	"media_type" text NOT NULL,
	"byte_length" integer NOT NULL,
	"content_hash" text NOT NULL,
	"object_iv" text NOT NULL,
	"data_key_version" integer NOT NULL,
	"created_at" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "inbound_events" ADD COLUMN "attachment_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "message_attachments_event_ordinal_uq" ON "message_attachments" ("inbound_event_id","ordinal");--> statement-breakpoint
CREATE UNIQUE INDEX "message_attachments_object_key_uq" ON "message_attachments" ("object_key");--> statement-breakpoint
CREATE INDEX "message_attachments_message_idx" ON "message_attachments" ("message_id");