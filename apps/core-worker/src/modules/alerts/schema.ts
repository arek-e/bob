import { index, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"

export const operationalAlerts = sqliteTable(
  "operational_alerts",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    code: text("code", {
      enum: [
        "inbound_exhausted",
        "delivery_uncertain",
        "delivery_result_exhausted",
        "agent_authentication_failed",
        "reminder_missed"
      ]
    }).notNull(),
    objectType: text("object_type").notNull(),
    objectId: text("object_id").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    state: text("state", { enum: ["open", "reconciling", "resolved"] }).notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    resolvedAt: text("resolved_at")
  },
  (table) => [
    uniqueIndex("operational_alerts_idempotency_uq").on(table.idempotencyKey),
    index("operational_alerts_owner_state_idx").on(table.userId, table.state, table.createdAt)
  ]
)
