import { drizzle } from "drizzle-orm/d1"

import * as conversationSchema from "./modules/conversations/schema.ts"
import * as deliverySchema from "./modules/delivery/schema.ts"
import * as journalSchema from "./modules/journal/schema.ts"
import * as memorySchema from "./modules/memory/schema.ts"
import * as reminderSchema from "./modules/reminders/schema.ts"
import * as trainingSchema from "./modules/training/schema.ts"

export const coreSchema = {
  ...conversationSchema,
  ...deliverySchema,
  ...journalSchema,
  ...memorySchema,
  ...reminderSchema,
  ...trainingSchema
}

export function createCoreDatabase(binding: D1Database) {
  return drizzle(binding)
}

export type CoreDatabase = ReturnType<typeof createCoreDatabase>
