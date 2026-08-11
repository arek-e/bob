import { drizzle } from "drizzle-orm/d1"

import * as connectionSchema from "./modules/connections/schema.ts"
import * as conversationSchema from "./modules/conversations/schema.ts"
import * as deliverySchema from "./modules/delivery/schema.ts"
import * as journalSchema from "./modules/journal/schema.ts"
import * as memorySchema from "./modules/memory/schema.ts"
import * as observabilitySchema from "./modules/observability/schema.ts"
import * as reminderSchema from "./modules/reminders/schema.ts"
import * as trainingSchema from "./modules/training/schema.ts"

export const coreSchema = {
  ...connectionSchema,
  ...conversationSchema,
  ...deliverySchema,
  ...journalSchema,
  ...memorySchema,
  ...observabilitySchema,
  ...reminderSchema,
  ...trainingSchema
}

export function createCoreDatabase(binding: D1Database) {
  return drizzle(binding)
}

export type CoreDatabase = ReturnType<typeof createCoreDatabase>
