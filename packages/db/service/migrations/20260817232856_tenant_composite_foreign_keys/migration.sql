CREATE UNIQUE INDEX "agent_runs_user_id_id_uq" ON "agent_runs" ("user_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "channels_user_id_id_uq" ON "channels" ("user_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "conversation_turns_user_id_id_uq" ON "conversation_turns" ("user_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "inbound_events_user_id_id_uq" ON "inbound_events" ("user_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "messages_user_id_id_uq" ON "messages" ("user_id","id");--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_owner_event_fk" FOREIGN KEY ("user_id","inbound_event_id") REFERENCES "inbound_events"("user_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_owner_turn_fk" FOREIGN KEY ("user_id","turn_id") REFERENCES "conversation_turns"("user_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_owner_message_fk" FOREIGN KEY ("user_id","target_message_id") REFERENCES "messages"("user_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "conversation_turns" ADD CONSTRAINT "conversation_turns_owner_channel_fk" FOREIGN KEY ("user_id","channel_id") REFERENCES "channels"("user_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "conversation_turns" ADD CONSTRAINT "conversation_turns_owner_event_fk" FOREIGN KEY ("user_id","latest_inbound_event_id") REFERENCES "inbound_events"("user_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "conversation_turns" ADD CONSTRAINT "conversation_turns_owner_message_fk" FOREIGN KEY ("user_id","latest_message_id") REFERENCES "messages"("user_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "inbound_events" ADD CONSTRAINT "inbound_events_owner_channel_fk" FOREIGN KEY ("user_id","channel_id") REFERENCES "channels"("user_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "inbound_events" ADD CONSTRAINT "inbound_events_owner_message_fk" FOREIGN KEY ("user_id","message_id") REFERENCES "messages"("user_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "message_attachments" ADD CONSTRAINT "message_attachments_owner_message_fk" FOREIGN KEY ("user_id","message_id") REFERENCES "messages"("user_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "message_attachments" ADD CONSTRAINT "message_attachments_owner_event_fk" FOREIGN KEY ("user_id","inbound_event_id") REFERENCES "inbound_events"("user_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_owner_channel_fk" FOREIGN KEY ("user_id","channel_id") REFERENCES "channels"("user_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "short_reply_bindings" ADD CONSTRAINT "short_reply_bindings_owner_message_fk" FOREIGN KEY ("user_id","outbound_message_id") REFERENCES "messages"("user_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "tool_calls" ADD CONSTRAINT "tool_calls_owner_run_fk" FOREIGN KEY ("owner_id","run_id") REFERENCES "agent_runs"("user_id","id") ON DELETE CASCADE;