import { index, integer, pgTable, text } from "drizzle-orm/pg-core"

import { users } from "./conversations.ts"

export const agentUsage = pgTable(
  "agent_usage",
  {
    runId: text("run_id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    correlationId: text("correlation_id").notNull(),
    feature: text("feature").notNull(),
    workflow: text("workflow", { enum: ["agent_turn"] }).notNull(),
    provider: text("provider", { enum: ["openai-codex"] }).notNull(),
    model: text("model").notNull(),
    status: text("status", { enum: ["completed", "failed", "cancelled"] }).notNull(),
    inputTokens: integer("input_tokens").notNull(),
    outputTokens: integer("output_tokens").notNull(),
    toolCalls: integer("tool_calls").notNull(),
    durationMs: integer("duration_ms").notNull(),
    occurredAt: text("occurred_at").notNull()
  },
  (table) => [
    index("agent_usage_owner_time_idx").on(table.userId, table.occurredAt),
    index("agent_usage_feature_workflow_idx").on(
      table.userId,
      table.feature,
      table.workflow,
      table.occurredAt
    )
  ]
)
