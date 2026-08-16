import { boolean, index, integer, pgTable, text, uniqueIndex } from "drizzle-orm/pg-core"

export const reminders = pgTable("reminders", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  sourceMessageId: text("source_message_id").notNull(),
  originalWordingCiphertext: text("original_wording_ciphertext").notNull(),
  originalWordingIv: text("original_wording_iv").notNull(),
  displayTextCiphertext: text("display_text_ciphertext").notNull(),
  displayTextIv: text("display_text_iv").notNull(),
  smsSafeTextCiphertext: text("sms_safe_text_ciphertext").notNull(),
  smsSafeTextIv: text("sms_safe_text_iv").notNull(),
  dataKeyVersion: integer("data_key_version").notNull(),
  sensitivity: text("sensitivity", { enum: ["normal", "private", "high"] }).notNull(),
  scheduleKind: text("schedule_kind", { enum: ["one_shot", "recurring"] }).notNull(),
  localStartDate: text("local_start_date").notNull(),
  localStartTime: text("local_start_time").notNull(),
  timeZone: text("time_zone").notNull(),
  rrule: text("rrule"),
  nextDueAt: text("next_due_at"),
  quietHoursBehavior: text("quiet_hours_behavior", { enum: ["defer", "allow"] }).notNull(),
  requiresAcknowledgment: boolean("requires_acknowledgment").notNull(),
  responseDeadlineMinutes: integer("response_deadline_minutes").notNull(),
  repeatPolicy: text("repeat_policy", { enum: ["none", "until_seen"] }).notNull(),
  maxAttempts: integer("max_attempts").notNull(),
  channelId: text("channel_id").notNull(),
  state: text("state", {
    enum: ["active", "paused", "cancelled", "completed", "archived"]
  }).notNull(),
  scheduleRevision: integer("schedule_revision").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull()
})

export const reminderOccurrences = pgTable(
  "reminder_occurrences",
  {
    id: text("id").primaryKey(),
    reminderId: text("reminder_id").notNull(),
    sequence: integer("sequence").notNull(),
    intendedDueAt: text("intended_due_at").notNull(),
    localDisplayTime: text("local_display_time").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    state: text("state", {
      enum: [
        "scheduled",
        "claimed",
        "awaiting_delivery",
        "awaiting_response",
        "acknowledged",
        "completed",
        "snoozed",
        "missed",
        "cancelled"
      ]
    }).notNull(),
    claimToken: text("claim_token"),
    claimedAt: text("claimed_at"),
    claimExpiresAt: text("claim_expires_at"),
    responseDeadlineAt: text("response_deadline_at"),
    snoozedToOccurrenceId: text("snoozed_to_occurrence_id"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull()
  },
  (table) => [
    uniqueIndex("reminder_occurrences_idempotency_uq").on(table.idempotencyKey),
    index("reminder_occurrences_due_idx").on(table.state, table.intendedDueAt),
    index("reminder_occurrences_claim_idx").on(table.claimExpiresAt)
  ]
)

export const reminderActions = pgTable(
  "reminder_actions",
  {
    id: text("id").primaryKey(),
    reminderId: text("reminder_id").notNull(),
    occurrenceId: text("occurrence_id"),
    action: text("action", {
      enum: ["created", "acknowledged", "completed", "snoozed", "cancelled", "paused", "resumed"]
    }).notNull(),
    actor: text("actor", { enum: ["owner", "system"] }).notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    createdAt: text("created_at").notNull()
  },
  (table) => [uniqueIndex("reminder_actions_idempotency_uq").on(table.idempotencyKey)]
)

export const schedulerOutbox = pgTable(
  "scheduler_outbox",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    reminderId: text("reminder_id").notNull(),
    scheduleRevision: integer("schedule_revision").notNull(),
    command: text("command", { enum: ["upsert", "remove", "reconcile"] }).notNull(),
    enqueuedAt: text("enqueued_at"),
    processedAt: text("processed_at"),
    createdAt: text("created_at").notNull()
  },
  (table) => [
    uniqueIndex("scheduler_revision_uq").on(table.reminderId, table.scheduleRevision),
    index("scheduler_publish_idx").on(table.enqueuedAt, table.processedAt)
  ]
)
