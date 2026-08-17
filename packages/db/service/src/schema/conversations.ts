import { sql } from "drizzle-orm"
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  text,
  uniqueIndex
} from "drizzle-orm/pg-core"

export const users = pgTable("users", {
  id: text("id").primaryKey(),
  timeZone: text("time_zone").notNull(),
  locale: text("locale").notNull().default("en"),
  hourCycle: text("hour_cycle", { enum: ["auto", "h12", "h23"] })
    .notNull()
    .default("auto"),
  wrappedDataKey: text("wrapped_data_key"),
  wrappedDataKeyIv: text("wrapped_data_key_iv"),
  dataKeyVersion: integer("data_key_version"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull()
})

export const channels = pgTable(
  "channels",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
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
    uniqueIndex("channels_user_id_id_uq").on(table.userId, table.id),
    uniqueIndex("channels_provider_address_uq").on(
      table.provider,
      table.accountId,
      table.lineId,
      table.senderHash
    )
  ]
)

export const messages = pgTable(
  "messages",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    channelId: text("channel_id").notNull(),
    direction: text("direction", { enum: ["inbound", "outbound"] }).notNull(),
    textCiphertext: text("text_ciphertext").notNull(),
    textIv: text("text_iv").notNull(),
    dataKeyVersion: integer("data_key_version").notNull(),
    occurredAt: text("occurred_at").notNull(),
    createdAt: text("created_at").notNull()
  },
  (table) => [
    uniqueIndex("messages_user_id_id_uq").on(table.userId, table.id),
    foreignKey({
      columns: [table.userId, table.channelId],
      foreignColumns: [channels.userId, channels.id],
      name: "messages_owner_channel_fk"
    }).onDelete("cascade"),
    index("messages_conversation_idx").on(table.channelId, table.occurredAt)
  ]
)

export const messageEvents = pgTable(
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

export const inboundEvents = pgTable(
  "inbound_events",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    channelId: text("channel_id").notNull(),
    messageId: text("message_id").notNull(),
    accountId: text("account_id").notNull(),
    lineId: text("line_id").notNull(),
    providerMessageHandle: text("provider_message_handle").notNull(),
    replyToProviderMessageHandle: text("reply_to_provider_message_handle"),
    service: text("service", { enum: ["imessage", "sms", "rcs", "unknown"] })
      .notNull()
      .default("unknown"),
    isGroup: boolean("is_group").notNull().default(false),
    attachmentCount: integer("attachment_count").notNull().default(0),
    reactionClaimedAt: text("reaction_claimed_at"),
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
    uniqueIndex("inbound_events_user_id_id_uq").on(table.userId, table.id),
    foreignKey({
      columns: [table.userId, table.channelId],
      foreignColumns: [channels.userId, channels.id],
      name: "inbound_events_owner_channel_fk"
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.userId, table.messageId],
      foreignColumns: [messages.userId, messages.id],
      name: "inbound_events_owner_message_fk"
    }).onDelete("cascade"),
    uniqueIndex("inbound_events_provider_uq").on(
      table.accountId,
      table.lineId,
      table.providerMessageHandle
    ),
    index("inbound_events_work_idx").on(table.processedAt, table.claimExpiresAt)
  ]
)

export const messageAttachments = pgTable(
  "message_attachments",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    messageId: text("message_id").notNull(),
    inboundEventId: text("inbound_event_id").notNull(),
    ordinal: integer("ordinal").notNull(),
    objectKey: text("object_key").notNull(),
    mediaType: text("media_type", { enum: ["image/jpeg", "image/png"] }).notNull(),
    byteLength: integer("byte_length").notNull(),
    contentHash: text("content_hash").notNull(),
    objectIv: text("object_iv").notNull(),
    dataKeyVersion: integer("data_key_version").notNull(),
    createdAt: text("created_at").notNull()
  },
  (table) => [
    foreignKey({
      columns: [table.userId, table.messageId],
      foreignColumns: [messages.userId, messages.id],
      name: "message_attachments_owner_message_fk"
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.userId, table.inboundEventId],
      foreignColumns: [inboundEvents.userId, inboundEvents.id],
      name: "message_attachments_owner_event_fk"
    }).onDelete("cascade"),
    uniqueIndex("message_attachments_event_ordinal_uq").on(table.inboundEventId, table.ordinal),
    uniqueIndex("message_attachments_object_key_uq").on(table.objectKey),
    index("message_attachments_message_idx").on(table.messageId)
  ]
)

export const conversationTurns = pgTable(
  "conversation_turns",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    channelId: text("channel_id").notNull(),
    status: text("status", {
      enum: ["collecting", "running", "settling", "committing", "replied"]
    }).notNull(),
    revision: integer("revision").notNull(),
    contextEligible: boolean("context_eligible"),
    latestInboundEventId: text("latest_inbound_event_id").notNull(),
    latestMessageId: text("latest_message_id").notNull(),
    activeRunId: text("active_run_id"),
    activeRunRevision: integer("active_run_revision"),
    claimedRevision: integer("claimed_revision"),
    claimedAt: text("claimed_at"),
    claimExpiresAt: text("claim_expires_at"),
    quietUntil: text("quiet_until").notNull(),
    burstExpiresAt: text("burst_expires_at").notNull(),
    replyOutboxId: text("reply_outbox_id"),
    mutationIdempotencyKey: text("mutation_idempotency_key"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    repliedAt: text("replied_at")
  },
  (table) => [
    uniqueIndex("conversation_turns_user_id_id_uq").on(table.userId, table.id),
    foreignKey({
      columns: [table.userId, table.channelId],
      foreignColumns: [channels.userId, channels.id],
      name: "conversation_turns_owner_channel_fk"
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.userId, table.latestInboundEventId],
      foreignColumns: [inboundEvents.userId, inboundEvents.id],
      name: "conversation_turns_owner_event_fk"
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.userId, table.latestMessageId],
      foreignColumns: [messages.userId, messages.id],
      name: "conversation_turns_owner_message_fk"
    }).onDelete("cascade"),
    uniqueIndex("conversation_turns_open_uq")
      .on(table.userId, table.channelId)
      .where(sql`${table.status} <> 'replied'`),
    index("conversation_turns_channel_status_idx").on(
      table.userId,
      table.channelId,
      table.status,
      table.updatedAt
    )
  ]
)

export const conversationTurnMessages = pgTable(
  "conversation_turn_messages",
  {
    turnId: text("turn_id").notNull(),
    inboundEventId: text("inbound_event_id").notNull(),
    messageId: text("message_id").notNull(),
    ordinal: integer("ordinal").notNull(),
    revision: integer("revision").notNull(),
    traceparent: text("traceparent"),
    createdAt: text("created_at").notNull()
  },
  (table) => [
    uniqueIndex("conversation_turn_messages_event_uq").on(table.inboundEventId),
    uniqueIndex("conversation_turn_messages_ordinal_uq").on(table.turnId, table.ordinal),
    index("conversation_turn_messages_order_idx").on(table.turnId, table.ordinal)
  ]
)

export const agentRuns = pgTable(
  "agent_runs",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    inboundEventId: text("inbound_event_id"),
    originType: text("origin_type", {
      enum: ["conversation_turn", "scheduled", "proactive", "legacy_inbound"]
    }),
    originId: text("origin_id"),
    conversationTurnId: text("turn_id"),
    conversationTurnRevision: integer("turn_revision"),
    targetMessageId: text("target_message_id"),
    correlationId: text("correlation_id").notNull(),
    inputSnapshotJson: text("input_snapshot_json").notNull(),
    inputHash: text("input_hash").notNull(),
    submissionHash: text("submission_hash"),
    status: text("status", {
      enum: [
        "pending",
        "claimed",
        "executing",
        "accepted",
        "queued",
        "running",
        "retry_wait",
        "waiting_effect",
        "awaiting_finalization",
        "completed",
        "failed",
        "cancelled",
        "unknown",
        "superseded",
        "indeterminate"
      ]
    }).notNull(),
    model: text("model").notNull(),
    idempotencyKey: text("idempotency_key"),
    executionPoolId: text("execution_pool_id"),
    jobProtocolVersion: integer("job_protocol_version").notNull().default(1),
    coreGatewayProtocolVersion: integer("core_gateway_protocol_version").notNull().default(1),
    checkpointLoopVersion: integer("checkpoint_loop_version").notNull().default(1),
    dispatchGeneration: integer("dispatch_generation").notNull().default(1),
    activeAttemptFence: integer("active_attempt_fence").notNull().default(0),
    controlRevision: integer("control_revision").notNull().default(0),
    cancellationRequestedAt: text("cancellation_requested_at"),
    cancellationReason: text("cancellation_reason", {
      enum: ["owner_request", "superseded", "operator_drain", "policy"]
    }),
    outcomeSnapshotJson: text("outcome_snapshot_json"),
    outcomeHash: text("outcome_hash"),
    finalizationCompletedAt: text("finalization_completed_at"),
    claimedAt: text("claimed_at"),
    claimExpiresAt: text("claim_expires_at"),
    activeAttemptId: text("active_attempt_id"),
    completedAt: text("completed_at"),
    createdAt: text("created_at").notNull()
  },
  (table) => [
    uniqueIndex("agent_runs_user_id_id_uq").on(table.userId, table.id),
    foreignKey({
      columns: [table.userId, table.inboundEventId],
      foreignColumns: [inboundEvents.userId, inboundEvents.id],
      name: "agent_runs_owner_event_fk"
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.userId, table.conversationTurnId],
      foreignColumns: [conversationTurns.userId, conversationTurns.id],
      name: "agent_runs_owner_turn_fk"
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.userId, table.targetMessageId],
      foreignColumns: [messages.userId, messages.id],
      name: "agent_runs_owner_message_fk"
    }).onDelete("cascade"),
    uniqueIndex("agent_runs_legacy_inbound_uq")
      .on(table.inboundEventId)
      .where(sql`${table.conversationTurnId} IS NULL`),
    uniqueIndex("agent_runs_turn_revision_uq")
      .on(table.conversationTurnId, table.conversationTurnRevision)
      .where(
        sql`${table.conversationTurnId} IS NOT NULL AND ${table.conversationTurnRevision} IS NOT NULL`
      ),
    uniqueIndex("agent_runs_owner_idempotency_uq")
      .on(table.userId, table.idempotencyKey)
      .where(sql`${table.idempotencyKey} IS NOT NULL`),
    index("agent_runs_dispatch_idx").on(table.status, table.executionPoolId, table.createdAt),
    check("agent_runs_dispatch_generation_positive", sql`${table.dispatchGeneration} > 0`),
    check("agent_runs_active_fence_non_negative", sql`${table.activeAttemptFence} >= 0`),
    check("agent_runs_control_revision_non_negative", sql`${table.controlRevision} >= 0`)
  ]
)

export const agentRunAttempts = pgTable(
  "agent_run_attempts",
  {
    id: text("id").primaryKey(),
    runId: text("run_id").notNull(),
    attemptNumber: integer("attempt_number").notNull(),
    fence: integer("fence").notNull().default(0),
    workerId: text("worker_id"),
    leaseExpiresAt: text("lease_expires_at"),
    status: text("status").notNull(),
    errorCode: text("error_code"),
    startedAt: text("started_at").notNull(),
    finishedAt: text("finished_at")
  },
  (table) => [
    uniqueIndex("agent_run_attempts_sequence_uq").on(table.runId, table.attemptNumber),
    uniqueIndex("agent_run_attempts_fence_uq").on(table.runId, table.fence),
    index("agent_run_attempts_lease_idx").on(table.status, table.leaseExpiresAt),
    check("agent_run_attempts_number_positive", sql`${table.attemptNumber} > 0`),
    check("agent_run_attempts_fence_non_negative", sql`${table.fence} >= 0`)
  ]
)

export const agentRunOutbox = pgTable(
  "agent_run_outbox",
  {
    id: text("id").primaryKey(),
    runId: text("run_id").notNull(),
    kind: text("kind", { enum: ["dispatch", "continuation", "control"] }).notNull(),
    generation: integer("generation").notNull(),
    state: text("state", { enum: ["pending", "claimed", "published", "failed"] }).notNull(),
    availableAt: text("available_at").notNull(),
    claimedAt: text("claimed_at"),
    claimToken: text("claim_token"),
    claimExpiresAt: text("claim_expires_at"),
    publishedAt: text("published_at"),
    failureCount: integer("failure_count").notNull().default(0),
    createdAt: text("created_at").notNull()
  },
  (table) => [
    uniqueIndex("agent_run_outbox_generation_uq").on(table.runId, table.kind, table.generation),
    index("agent_run_outbox_publish_idx").on(table.kind, table.state, table.availableAt),
    check("agent_run_outbox_generation_positive", sql`${table.generation} > 0`),
    check("agent_run_outbox_failure_count_non_negative", sql`${table.failureCount} >= 0`)
  ]
)

export const ownerWakeOutbox = pgTable(
  "owner_wake_outbox",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    requestedAt: text("requested_at").notNull(),
    state: text("state", { enum: ["pending", "published", "completed"] }).notNull(),
    publishedAt: text("published_at"),
    completedAt: text("completed_at"),
    createdAt: text("created_at").notNull()
  },
  (table) => [index("owner_wake_outbox_recovery_idx").on(table.state, table.requestedAt)]
)

export const agentRunOperations = pgTable(
  "agent_run_operations",
  {
    id: text("id").primaryKey(),
    runId: text("run_id").notNull(),
    sequence: integer("sequence").notNull(),
    kind: text("kind", { enum: ["model", "tool", "final"] }).notNull(),
    loopVersion: integer("loop_version").notNull(),
    payloadCiphertext: text("payload_ciphertext").notNull(),
    payloadIv: text("payload_iv").notNull(),
    payloadHash: text("payload_hash").notNull(),
    dataKeyVersion: integer("data_key_version").notNull(),
    createdByAttemptId: text("created_by_attempt_id").notNull(),
    createdAt: text("created_at").notNull()
  },
  (table) => [
    uniqueIndex("agent_run_operations_sequence_uq").on(table.runId, table.sequence),
    index("agent_run_operations_order_idx").on(table.runId, table.sequence)
  ]
)

export const toolCalls = pgTable(
  "tool_calls",
  {
    id: text("id").primaryKey(),
    runId: text("run_id").notNull(),
    toolCallId: text("tool_call_id").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    ownerId: text("owner_id").references(() => users.id, { onDelete: "cascade" }),
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
    foreignKey({
      columns: [table.ownerId, table.runId],
      foreignColumns: [agentRuns.userId, agentRuns.id],
      name: "tool_calls_owner_run_fk"
    }).onDelete("cascade"),
    uniqueIndex("tool_calls_run_call_uq").on(table.runId, table.toolCallId),
    uniqueIndex("tool_calls_idempotency_uq").on(table.idempotencyKey)
  ]
)

export const effectAttempts = pgTable(
  "effect_attempts",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
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

export const shortReplyBindings = pgTable(
  "short_reply_bindings",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
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
    foreignKey({
      columns: [table.userId, table.outboundMessageId],
      foreignColumns: [messages.userId, messages.id],
      name: "short_reply_bindings_owner_message_fk"
    }).onDelete("cascade"),
    index("short_reply_pending_idx").on(table.userId, table.command, table.expiresAt),
    uniqueIndex("short_reply_target_uq").on(
      table.outboundMessageId,
      table.command,
      table.targetType,
      table.targetId
    )
  ]
)

export const auditEvents = pgTable("audit_events", {
  id: text("id").primaryKey(),
  userId: text("user_id").references(() => users.id, { onDelete: "set null" }),
  correlationId: text("correlation_id").notNull(),
  action: text("action").notNull(),
  objectType: text("object_type").notNull(),
  objectId: text("object_id").notNull(),
  decisionCode: text("decision_code").notNull(),
  contentRedacted: boolean("content_redacted").notNull(),
  createdAt: text("created_at").notNull()
})
