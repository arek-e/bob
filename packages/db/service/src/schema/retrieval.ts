import { sql } from "drizzle-orm"
import { boolean, index, integer, pgTable, text, uniqueIndex } from "drizzle-orm/pg-core"

export const searchDocuments = pgTable(
  "search_documents",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    sourceType: text("source_type").notNull(),
    sourceId: text("source_id").notNull(),
    memoryClass: text("memory_class", {
      enum: ["owner_fact", "owner_episode", "agent_experience"]
    })
      .notNull()
      .default("owner_episode"),
    text: text("text").notNull(),
    searchText: text("search_text").notNull().default(""),
    contentHash: text("content_hash"),
    sourceLabel: text("source_label").notNull(),
    occurredAt: text("occurred_at"),
    conflictKey: text("conflict_key"),
    validFrom: text("valid_from"),
    validTo: text("valid_to"),
    importance: integer("importance").notNull(),
    sensitivity: text("sensitivity").notNull(),
    modelEligible: boolean("model_eligible").notNull(),
    channelEligible: boolean("channel_eligible").notNull(),
    deletedAt: text("deleted_at"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull()
  },
  (table) => [
    uniqueIndex("search_documents_source_uq").on(table.sourceType, table.sourceId),
    index("search_documents_owner_validity_idx").on(
      table.userId,
      table.deletedAt,
      table.validFrom,
      table.validTo
    ),
    index("search_documents_full_text_idx").using(
      "gin",
      sql`to_tsvector('simple', ${table.searchText} || ' ' || ${table.sourceLabel})`
    )
  ]
)
