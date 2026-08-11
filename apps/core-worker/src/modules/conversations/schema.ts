import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"

export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  timeZone: text("time_zone").notNull(),
  wrappedDataKey: text("wrapped_data_key"),
  wrappedDataKeyIv: text("wrapped_data_key_iv"),
  dataKeyVersion: integer("data_key_version"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull()
})

export const channels = sqliteTable(
  "channels",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    provider: text("provider", { enum: ["sendblue"] }).notNull(),
    accountId: text("account_id").notNull(),
    lineId: text("line_id").notNull(),
    senderHash: text("sender_hash").notNull(),
    senderCiphertext: text("sender_ciphertext").notNull(),
    senderIv: text("sender_iv").notNull(),
    destinationHash: text("destination_hash").notNull(),
    destinationCiphertext: text("destination_ciphertext").notNull(),
    destinationIv: text("destination_iv").notNull(),
    optedOutAt: text("opted_out_at"),
    optedInAt: text("opted_in_at"),
    createdAt: text("created_at").notNull()
  },
  (table) => [
    uniqueIndex("channels_provider_address_uq").on(
      table.provider,
      table.accountId,
      table.lineId,
      table.senderHash
    )
  ]
)

export const messages = sqliteTable(
  "messages",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    channelId: text("channel_id").notNull(),
    direction: text("direction", { enum: ["inbound", "outbound"] }).notNull(),
    textCiphertext: text("text_ciphertext").notNull(),
    textIv: text("text_iv").notNull(),
    dataKeyVersion: integer("data_key_version").notNull(),
    occurredAt: text("occurred_at").notNull(),
    createdAt: text("created_at").notNull()
  },
  (table) => [index("messages_conversation_idx").on(table.channelId, table.occurredAt)]
)

export const messageEvents = sqliteTable(
  "message_events",
  {
    id: text("id").primaryKey(),
    messageId: text("message_id").notNull(),
    kind: text("kind").notNull(),
    providerStatus: text("provider_status"),
    occurredAt: text("occurred_at").notNull(),
    createdAt: text("created_at").notNull()
  },
  (table) => [index("message_events_message_idx").on(table.messageId, table.occurredAt)]
)

export const inboundEvents = sqliteTable(
  "inbound_events",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    channelId: text("channel_id").notNull(),
    messageId: text("message_id").notNull(),
    accountId: text("account_id").notNull(),
    lineId: text("line_id").notNull(),
    providerMessageHandle: text("provider_message_handle").notNull(),
    correlationId: text("correlation_id").notNull(),
    enqueuedAt: text("enqueued_at"),
    claimedAt: text("claimed_at"),
    claimExpiresAt: text("claim_expires_at"),
    processedAt: text("processed_at"),
    deadLetteredAt: text("dead_lettered_at"),
    recoveryCount: integer("recovery_count").notNull().default(0),
    createdAt: text("created_at").notNull()
  },
  (table) => [
    uniqueIndex("inbound_events_provider_uq").on(
      table.accountId,
      table.lineId,
      table.providerMessageHandle
    ),
    index("inbound_events_work_idx").on(table.processedAt, table.claimExpiresAt)
  ]
)

export const agentRuns = sqliteTable(
  "agent_runs",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    inboundEventId: text("inbound_event_id").notNull(),
    correlationId: text("correlation_id").notNull(),
    inputSnapshotJson: text("input_snapshot_json").notNull(),
    inputHash: text("input_hash").notNull(),
    status: text("status", {
      enum: ["pending", "claimed", "executing", "completed", "failed", "unknown"]
    }).notNull(),
    model: text("model").notNull(),
    claimedAt: text("claimed_at"),
    claimExpiresAt: text("claim_expires_at"),
    completedAt: text("completed_at"),
    createdAt: text("created_at").notNull()
  },
  (table) => [uniqueIndex("agent_runs_inbound_uq").on(table.inboundEventId)]
)

export const agentRunAttempts = sqliteTable("agent_run_attempts", {
  id: text("id").primaryKey(),
  runId: text("run_id").notNull(),
  attemptNumber: integer("attempt_number").notNull(),
  status: text("status").notNull(),
  errorCode: text("error_code"),
  startedAt: text("started_at").notNull(),
  finishedAt: text("finished_at")
})

export const toolCalls = sqliteTable(
  "tool_calls",
  {
    id: text("id").primaryKey(),
    runId: text("run_id").notNull(),
    toolCallId: text("tool_call_id").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    ownerId: text("owner_id"),
    toolName: text("tool_name").notNull(),
    commandHash: text("command_hash"),
    argumentsJson: text("arguments_json").notNull(),
    resultJson: text("result_json"),
    status: text("status").notNull(),
    claimToken: text("claim_token"),
    claimedAt: text("claimed_at"),
    claimExpiresAt: text("claim_expires_at"),
    attemptNumber: integer("attempt_number").notNull().default(0),
    createdAt: text("created_at").notNull(),
    completedAt: text("completed_at")
  },
  (table) => [
    uniqueIndex("tool_calls_run_call_uq").on(table.runId, table.toolCallId),
    uniqueIndex("tool_calls_idempotency_uq").on(table.idempotencyKey)
  ]
)

export const effectAttempts = sqliteTable(
  "effect_attempts",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    kind: text("kind").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    state: text("state", {
      enum: ["pending", "claimed", "executing", "completed", "failed", "unknown"]
    }).notNull(),
    resultRef: text("result_ref"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull()
  },
  (table) => [uniqueIndex("effect_attempts_idempotency_uq").on(table.idempotencyKey)]
)

export const shortReplyBindings = sqliteTable(
  "short_reply_bindings",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    outboundMessageId: text("outbound_message_id").notNull(),
    command: text("command").notNull(),
    targetType: text("target_type").notNull(),
    targetId: text("target_id").notNull(),
    inverseCommandJson: text("inverse_command_json"),
    expiresAt: text("expires_at").notNull(),
    consumedAt: text("consumed_at"),
    createdAt: text("created_at").notNull()
  },
  (table) => [
    index("short_reply_pending_idx").on(table.userId, table.command, table.expiresAt),
    uniqueIndex("short_reply_target_uq").on(
      table.outboundMessageId,
      table.command,
      table.targetType,
      table.targetId
    )
  ]
)

export const auditEvents = sqliteTable("audit_events", {
  id: text("id").primaryKey(),
  userId: text("user_id"),
  correlationId: text("correlation_id").notNull(),
  action: text("action").notNull(),
  objectType: text("object_type").notNull(),
  objectId: text("object_id").notNull(),
  decisionCode: text("decision_code").notNull(),
  contentRedacted: integer("content_redacted", { mode: "boolean" }).notNull(),
  createdAt: text("created_at").notNull()
})
