import { index, pgTable, text, uniqueIndex } from "drizzle-orm/pg-core"

export const externalConnections = pgTable(
  "external_connections",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id").notNull(),
    provider: text("provider", { enum: ["google_calendar", "microsoft_calendar"] }).notNull(),
    integrationId: text("integration_id").notNull(),
    connectionId: text("connection_id").notNull(),
    status: text("status", { enum: ["connected", "unavailable"] }).notNull(),
    connectedAt: text("connected_at").notNull(),
    updatedAt: text("updated_at").notNull()
  },
  (table) => [
    uniqueIndex("external_connections_owner_provider_uq").on(table.ownerId, table.provider),
    uniqueIndex("external_connections_nango_uq").on(table.integrationId, table.connectionId),
    index("external_connections_owner_idx").on(table.ownerId)
  ]
)
