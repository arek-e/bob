import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"

export const artifacts = sqliteTable(
  "artifacts",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    channelId: text("channel_id").notNull(),
    kind: text("kind", { enum: ["plan"] }).notNull(),
    currentRevision: integer("current_revision").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull()
  },
  (table) => [
    uniqueIndex("artifacts_owner_channel_kind_uq").on(table.userId, table.channelId, table.kind),
    index("artifacts_latest_idx").on(table.userId, table.channelId, table.updatedAt)
  ]
)

export const artifactRevisions = sqliteTable(
  "artifact_revisions",
  {
    artifactId: text("artifact_id").notNull(),
    revision: integer("revision").notNull(),
    contentCiphertext: text("content_ciphertext").notNull(),
    contentIv: text("content_iv").notNull(),
    renderedTextCiphertext: text("rendered_text_ciphertext").notNull(),
    renderedTextIv: text("rendered_text_iv").notNull(),
    dataKeyVersion: integer("data_key_version").notNull(),
    sourceIdsJson: text("source_ids_json").notNull(),
    createdByRunId: text("created_by_run_id").notNull(),
    createdAt: text("created_at").notNull()
  },
  (table) => [
    uniqueIndex("artifact_revisions_identity_uq").on(table.artifactId, table.revision),
    index("artifact_revisions_run_idx").on(table.createdByRunId)
  ]
)
