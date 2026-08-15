import { drizzle } from "drizzle-orm/d1"

export function createCoreDatabase(binding: D1Database) {
  return drizzle(binding)
}

export type CoreDatabase = ReturnType<typeof createCoreDatabase>
