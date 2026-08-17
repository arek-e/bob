import { boolean, index, integer, pgTable, text, uniqueIndex } from "drizzle-orm/pg-core"

import { users } from "./conversations.ts"

export const memoryCandidates = pgTable(
  "memory_candidates",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    scope: text("scope").notNull(),
    key: text("key").notNull(),
    proposedValueEnvelope: text("proposed_value_envelope").notNull(),
    // Keep these write-only columns until a later table rebuild removes the legacy constraints.
    legacyProposedValueJson: text("proposed_value_json").notNull().default("null"),
    legacyProposedValueCiphertext: text("proposed_value_ciphertext"),
    legacyProposedValueIv: text("proposed_value_iv"),
    canonicalTextCiphertext: text("canonical_text_ciphertext").notNull(),
    canonicalTextIv: text("canonical_text_iv").notNull(),
    memoryClass: text("memory_class", { enum: ["owner_fact"] })
      .notNull()
      .default("owner_fact"),
    originClass: text("origin_class").notNull(),
    sourceType: text("source_type").notNull(),
    sourceId: text("source_id").notNull(),
    sourceLabel: text("source_label"),
    sourceOccurredAt: text("source_occurred_at"),
    sourceContentHash: text("source_content_hash"),
    extractionConfidence: integer("extraction_confidence").notNull(),
    sensitivity: text("sensitivity").notNull(),
    status: text("status", {
      enum: ["proposed", "disputed", "claimed", "confirmed", "rejected"]
    }).notNull(),
    reviewClaimAction: text("review_claim_action", {
      enum: ["confirm", "correct", "reject"]
    }),
    reviewClaimId: text("review_claim_id"),
    reviewClaimExpiresAt: text("review_claim_expires_at"),
    reviewResultId: text("review_result_id"),
    createdAt: text("created_at").notNull(),
    reviewedAt: text("reviewed_at")
  },
  (table) => [
    index("memory_candidates_review_claim_idx").on(table.status, table.reviewClaimExpiresAt)
  ]
)

export const memoryReviewClaimGuards = pgTable("memory_review_claim_guards", {
  claimId: text("claim_id").primaryKey()
})

export const facts = pgTable(
  "facts",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    scope: text("scope").notNull(),
    key: text("key").notNull(),
    currentRevisionId: text("current_revision_id"),
    createdAt: text("created_at").notNull()
  },
  (table) => [uniqueIndex("facts_identity_uq").on(table.userId, table.scope, table.key)]
)

export const factRevisions = pgTable(
  "fact_revisions",
  {
    id: text("id").primaryKey(),
    factId: text("fact_id").notNull(),
    valueEnvelope: text("value_envelope").notNull(),
    // Keep these write-only columns until a later table rebuild removes the legacy constraints.
    legacyValueJson: text("value_json").notNull().default("null"),
    legacyValueCiphertext: text("value_ciphertext"),
    legacyValueIv: text("value_iv"),
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
    modelEligible: boolean("model_eligible").notNull(),
    channelEligible: boolean("channel_eligible").notNull(),
    supersedesRevisionId: text("supersedes_revision_id"),
    createdAt: text("created_at").notNull()
  },
  (table) => [index("fact_revisions_fact_idx").on(table.factId, table.createdAt)]
)

export const factEvidence = pgTable(
  "fact_evidence",
  {
    id: text("id").primaryKey(),
    revisionId: text("revision_id").notNull(),
    sourceType: text("source_type").notNull(),
    sourceId: text("source_id").notNull(),
    sourceLabel: text("source_label"),
    sourceOccurredAt: text("source_occurred_at"),
    evidenceRole: text("evidence_role", { enum: ["supports", "contradicts", "context"] }).notNull(),
    excerptHash: text("excerpt_hash").notNull(),
    createdAt: text("created_at").notNull()
  },
  (table) => [
    uniqueIndex("fact_evidence_source_uq").on(table.revisionId, table.sourceType, table.sourceId)
  ]
)

export const factRelations = pgTable("fact_relations", {
  id: text("id").primaryKey(),
  fromRevisionId: text("from_revision_id").notNull(),
  toRevisionId: text("to_revision_id").notNull(),
  relation: text("relation", { enum: ["supports", "contradicts", "supersedes"] }).notNull(),
  createdAt: text("created_at").notNull()
})
