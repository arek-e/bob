import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"

export const outboxMessages = sqliteTable(
  "outbox_messages",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    channelId: text("channel_id").notNull(),
    messageId: text("message_id").notNull(),
    reasonCode: text("reason_code").notNull(),
    correlationId: text("correlation_id").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    actionTargetType: text("action_target_type"),
    actionTargetId: text("action_target_id"),
    replyToProviderMessageHandle: text("reply_to_provider_message_handle"),
    state: text("state", {
      enum: ["pending", "claimed", "accepted", "failed", "uncertain", "cancelled"]
    }).notNull(),
    enqueuedAt: text("enqueued_at"),
    claimedAt: text("claimed_at"),
    claimExpiresAt: text("claim_expires_at"),
    completedAt: text("completed_at"),
    createdAt: text("created_at").notNull()
  },
  (table) => [
    uniqueIndex("outbox_idempotency_uq").on(table.idempotencyKey),
    index("outbox_publish_idx").on(table.enqueuedAt, table.state)
  ]
)

export const deliveryAttempts = sqliteTable(
  "delivery_attempts",
  {
    id: text("id").primaryKey(),
    outboxId: text("outbox_id").notNull(),
    attemptNumber: integer("attempt_number").notNull(),
    state: text("state", {
      enum: ["pending", "claimed", "sending", "accepted", "delivered", "uncertain", "failed"]
    }).notNull(),
    providerMessageHandle: text("provider_message_handle"),
    errorCode: text("error_code"),
    startedAt: text("started_at").notNull(),
    updatedAt: text("updated_at").notNull()
  },
  (table) => [
    uniqueIndex("delivery_attempt_sequence_uq").on(table.outboxId, table.attemptNumber),
    uniqueIndex("delivery_provider_handle_uq").on(table.providerMessageHandle)
  ]
)

export const providerEvents = sqliteTable(
  "provider_events",
  {
    id: text("id").primaryKey(),
    provider: text("provider").notNull(),
    providerMessageHandle: text("provider_message_handle").notNull(),
    providerStatus: text("provider_status", {
      enum: [
        "registered",
        "pending",
        "declined",
        "queued",
        "accepted",
        "sent",
        "delivered",
        "error",
        "opted_out"
      ]
    }).notNull(),
    providerEventKey: text("provider_event_key").notNull(),
    correlationId: text("correlation_id").notNull(),
    occurredAt: text("occurred_at").notNull(),
    createdAt: text("created_at").notNull()
  },
  (table) => [
    uniqueIndex("provider_events_key_uq").on(table.provider, table.providerEventKey),
    index("provider_events_message_idx").on(table.providerMessageHandle, table.occurredAt)
  ]
)
