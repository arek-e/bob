import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"

export const memoryCandidates = sqliteTable("memory_candidates", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  scope: text("scope").notNull(),
  key: text("key").notNull(),
  proposedValueJson: text("proposed_value_json").notNull(),
  proposedValueCiphertext: text("proposed_value_ciphertext"),
  proposedValueIv: text("proposed_value_iv"),
  canonicalTextCiphertext: text("canonical_text_ciphertext").notNull(),
  canonicalTextIv: text("canonical_text_iv").notNull(),
  originClass: text("origin_class").notNull(),
  sourceType: text("source_type").notNull(),
  sourceId: text("source_id").notNull(),
  extractionConfidence: integer("extraction_confidence").notNull(),
  sensitivity: text("sensitivity").notNull(),
  status: text("status", { enum: ["proposed", "disputed", "confirmed", "rejected"] }).notNull(),
  createdAt: text("created_at").notNull(),
  reviewedAt: text("reviewed_at")
})

export const facts = sqliteTable(
  "facts",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    scope: text("scope").notNull(),
    key: text("key").notNull(),
    currentRevisionId: text("current_revision_id"),
    createdAt: text("created_at").notNull()
  },
  (table) => [uniqueIndex("facts_identity_uq").on(table.userId, table.scope, table.key)]
)

export const factRevisions = sqliteTable(
  "fact_revisions",
  {
    id: text("id").primaryKey(),
    factId: text("fact_id").notNull(),
    valueJson: text("value_json").notNull(),
    valueCiphertext: text("value_ciphertext"),
    valueIv: text("value_iv"),
    canonicalTextCiphertext: text("canonical_text_ciphertext").notNull(),
    canonicalTextIv: text("canonical_text_iv").notNull(),
    dataKeyVersion: integer("data_key_version").notNull(),
    assertionKind: text("assertion_kind", {
      enum: ["user_stated", "system_recorded", "inferred"]
    }).notNull(),
    originClass: text("origin_class", {
      enum: [
        "owner_input",
        "system_record",
        "recalled_content",
        "tool_output",
        "assistant_output",
        "background_model"
      ]
    }).notNull(),
    observedAt: text("observed_at").notNull(),
    validFrom: text("valid_from"),
    validTo: text("valid_to"),
    extractionConfidence: integer("extraction_confidence").notNull(),
    importance: integer("importance").notNull(),
    verificationStatus: text("verification_status", {
      enum: ["proposed", "confirmed", "disputed", "superseded", "rejected"]
    }).notNull(),
    sensitivity: text("sensitivity", { enum: ["normal", "private", "high"] }).notNull(),
    modelEligible: integer("model_eligible", { mode: "boolean" }).notNull(),
    channelEligible: integer("channel_eligible", { mode: "boolean" }).notNull(),
    supersedesRevisionId: text("supersedes_revision_id"),
    createdAt: text("created_at").notNull()
  },
  (table) => [index("fact_revisions_fact_idx").on(table.factId, table.createdAt)]
)

export const factEvidence = sqliteTable(
  "fact_evidence",
  {
    id: text("id").primaryKey(),
    revisionId: text("revision_id").notNull(),
    sourceType: text("source_type").notNull(),
    sourceId: text("source_id").notNull(),
    evidenceRole: text("evidence_role", { enum: ["supports", "contradicts", "context"] }).notNull(),
    excerptHash: text("excerpt_hash").notNull(),
    createdAt: text("created_at").notNull()
  },
  (table) => [
    uniqueIndex("fact_evidence_source_uq").on(table.revisionId, table.sourceType, table.sourceId)
  ]
)

export const factRelations = sqliteTable("fact_relations", {
  id: text("id").primaryKey(),
  fromRevisionId: text("from_revision_id").notNull(),
  toRevisionId: text("to_revision_id").notNull(),
  relation: text("relation", { enum: ["supports", "contradicts", "supersedes"] }).notNull(),
  createdAt: text("created_at").notNull()
})

export const searchDocuments = sqliteTable(
  "search_documents",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    sourceType: text("source_type").notNull(),
    sourceId: text("source_id").notNull(),
    text: text("text").notNull(),
    sourceLabel: text("source_label").notNull(),
    occurredAt: text("occurred_at"),
    importance: integer("importance").notNull(),
    sensitivity: text("sensitivity").notNull(),
    modelEligible: integer("model_eligible", { mode: "boolean" }).notNull(),
    channelEligible: integer("channel_eligible", { mode: "boolean" }).notNull(),
    deletedAt: text("deleted_at"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull()
  },
  (table) => [uniqueIndex("search_documents_source_uq").on(table.sourceType, table.sourceId)]
)
