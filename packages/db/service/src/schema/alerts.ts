import { index, pgTable, text, uniqueIndex } from "drizzle-orm/pg-core"

export const operationalAlerts = pgTable(
  "operational_alerts",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    code: text("code").notNull(),
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
