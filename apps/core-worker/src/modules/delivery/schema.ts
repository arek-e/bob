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
    conversationTurnId: text("conversation_turn_id"),
    conversationTurnRevision: integer("conversation_turn_revision"),
    dependsOnOutboxId: text("depends_on_outbox_id"),
    artifactId: text("artifact_id"),
    artifactRevision: integer("artifact_revision"),
    state: text("state", {
      enum: ["pending", "claimed", "accepted", "failed", "uncertain", "cancelled"]
    }).notNull(),
    enqueuedAt: text("enqueued_at"),
    claimedAt: text("claimed_at"),
    claimToken: text("claim_token"),
    claimExpiresAt: text("claim_expires_at"),
    deadLetteredAt: text("dead_lettered_at"),
    dispatchGeneration: integer("dispatch_generation").notNull().default(0),
    recoveryCount: integer("recovery_count").notNull().default(0),
    completedAt: text("completed_at"),
    createdAt: text("created_at").notNull()
  },
  (table) => [
    uniqueIndex("outbox_idempotency_uq").on(table.idempotencyKey),
    index("outbox_publish_idx").on(table.enqueuedAt, table.state),
    index("outbox_dependency_idx").on(table.dependsOnOutboxId, table.state)
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
    payloadFingerprint: text("payload_fingerprint"),
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
