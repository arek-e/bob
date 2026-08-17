DROP INDEX "channels_provider_address_uq";--> statement-breakpoint
CREATE UNIQUE INDEX "channels_provider_address_uq" ON "channels" ("provider","account_id","line_id","sender_hash");