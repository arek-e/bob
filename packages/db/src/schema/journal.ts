import { index, integer, pgTable, text, uniqueIndex } from "drizzle-orm/pg-core"

export const journalHandoffs = pgTable("journal_handoffs", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  expiresAt: text("expires_at").notNull(),
  consumedAt: text("consumed_at"),
  createdAt: text("created_at").notNull()
})

export const journalEntries = pgTable(
  "journal_entries",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    handoffId: text("handoff_id").notNull(),
    textCiphertext: text("text_ciphertext").notNull(),
    textIv: text("text_iv").notNull(),
    dataKeyVersion: integer("data_key_version").notNull(),
    tagsJson: text("tags_json").notNull(),
    approvedSummary: text("approved_summary"),
    contentHash: text("content_hash").notNull(),
    redactedAt: text("redacted_at"),
    createdAt: text("created_at").notNull()
  },
  (table) => [
    index("journal_entries_date_idx").on(table.userId, table.createdAt),
    uniqueIndex("journal_entries_handoff_uq").on(table.handoffId)
  ]
)

export const attachments = pgTable(
  "attachments",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    journalEntryId: text("journal_entry_id"),
    r2Key: text("r2_key").notNull(),
    contentType: text("content_type").notNull(),
    byteLength: integer("byte_length").notNull(),
    contentHash: text("content_hash").notNull(),
    dataKeyVersion: integer("data_key_version").notNull(),
    deletedAt: text("deleted_at"),
    createdAt: text("created_at").notNull()
  },
  (table) => [uniqueIndex("attachments_r2_key_uq").on(table.r2Key)]
)
