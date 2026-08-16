import { sql } from "drizzle-orm"
import { afterAll, describe, expect, it } from "vitest"

import { connectPostgresqlDatabase, type PostgresqlDatabase } from "../src/postgresql.ts"

const databaseUrl = process.env.TEST_DATABASE_URL
const integration = databaseUrl === undefined ? describe.skip : describe

integration("native PostgreSQL database", () => {
  let database: PostgresqlDatabase | undefined

  afterAll(async () => {
    await database?.close()
  })

  it("applies the reset baseline and rolls back an invalid batch", async () => {
    if (databaseUrl === undefined) throw new Error("TEST_DATABASE_URL is required")
    database = connectPostgresqlDatabase(databaseUrl)
    await database.migrate()
    await database.migrate()

    const [tableCount] = await database.applicationStorage.execute<{ count: number }>(sql`
      SELECT count(*)::integer AS count
      FROM information_schema.tables
      WHERE table_schema = 'public'
    `)
    expect(tableCount?.count).toBeGreaterThan(40)

    const ownerId = "00000000-0000-4000-8000-000000000001"
    await expect(
      database.applicationStorage.batch([
        database.applicationStorage.execute(sql`
          INSERT INTO users (id, time_zone, locale, hour_cycle, created_at, updated_at)
          VALUES (${ownerId}, 'Europe/Stockholm', 'en', 'auto', '2026-08-16', '2026-08-16')
        `),
        database.applicationStorage.execute(sql`
          INSERT INTO users (id, time_zone, locale, hour_cycle, created_at, updated_at)
          VALUES (${ownerId}, 'Europe/Stockholm', 'en', 'auto', '2026-08-16', '2026-08-16')
        `)
      ])
    ).rejects.toThrow()

    const [ownerCount] = await database.applicationStorage.execute<{ count: number }>(sql`
      SELECT count(*)::integer AS count FROM users WHERE id = ${ownerId}
    `)
    expect(ownerCount?.count).toBe(0)

    await database.applicationStorage.execute(sql`
      INSERT INTO users (id, time_zone, locale, hour_cycle, created_at, updated_at)
      VALUES (${ownerId}, 'Europe/Stockholm', 'en', 'auto', '2026-08-16', '2026-08-16')
    `)
    const selected = await database.applicationStorage
      .select({ id: sql<string>`id` })
      .from(sql`users`)
      .where(sql`id = ${ownerId}`)
    expect(selected).toEqual([{ id: ownerId }])
  })
})
