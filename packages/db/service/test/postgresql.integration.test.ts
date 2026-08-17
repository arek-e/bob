import { sql } from "drizzle-orm"
import { Effect, ManagedRuntime } from "effect"
import { fileURLToPath } from "node:url"
import { afterAll, describe, expect, it } from "vitest"

import { PostgresqlDatabase, postgresqlDatabaseLayer } from "../src/postgresql.ts"

const databaseUrl = process.env.TEST_DATABASE_URL
const integration = databaseUrl === undefined ? describe.skip : describe
const migrationsFolder = fileURLToPath(new URL("../migrations", import.meta.url))

integration("native PostgreSQL database", () => {
  let dispose: (() => Promise<void>) | undefined

  afterAll(async () => {
    await dispose?.()
  })

  it("applies all migrations and rolls back an invalid transaction", async () => {
    if (databaseUrl === undefined) throw new Error("TEST_DATABASE_URL is required")
    const runtime = ManagedRuntime.make(postgresqlDatabaseLayer(databaseUrl, { migrationsFolder }))
    dispose = () => runtime.dispose()
    const database = await runtime.runPromise(PostgresqlDatabase)
    await runtime.runPromise(database.migrate)
    await runtime.runPromise(database.migrate)

    const [migrationCount] = await runtime.runPromise(
      database.applicationStorage
        .select({ count: sql<number>`count(*)::integer` })
        .from(sql`drizzle.__drizzle_migrations`)
    )
    expect(migrationCount?.count).toBe(6)

    const [fullTextIndex] = await runtime.runPromise(
      database.applicationStorage
        .select({ count: sql<number>`count(*)::integer` })
        .from(sql`pg_indexes`)
        .where(sql`schemaname = 'public' AND indexname = 'search_documents_full_text_idx'`)
    )
    expect(fullTextIndex?.count).toBe(1)

    const [tableCount] = await runtime.runPromise(
      database.applicationStorage
        .select({ count: sql<number>`count(*)::integer` })
        .from(sql`information_schema.tables`)
        .where(sql`table_schema = 'public'`)
    )
    expect(tableCount?.count).toBeGreaterThan(40)

    const ownerId = "00000000-0000-4000-8000-000000000001"
    await expect(
      runtime.runPromise(
        database.applicationStorage.transaction(() =>
          Effect.all(
            [
              database.applicationStorage.execute(sql`
                INSERT INTO users (id, time_zone, locale, hour_cycle, created_at, updated_at)
                VALUES (${ownerId}, 'Europe/Stockholm', 'en', 'auto', '2026-08-16', '2026-08-16')
              `),
              database.applicationStorage.execute(sql`
                INSERT INTO users (id, time_zone, locale, hour_cycle, created_at, updated_at)
                VALUES (${ownerId}, 'Europe/Stockholm', 'en', 'auto', '2026-08-16', '2026-08-16')
              `)
            ],
            { concurrency: 1 }
          )
        )
      )
    ).rejects.toThrow()

    const [ownerCount] = await runtime.runPromise(
      database.applicationStorage
        .select({ count: sql<number>`count(*)::integer` })
        .from(sql`users`)
        .where(sql`id = ${ownerId}`)
    )
    expect(ownerCount?.count).toBe(0)

    await runtime.runPromise(
      database.applicationStorage.execute(sql`
        INSERT INTO users (id, time_zone, locale, hour_cycle, created_at, updated_at)
        VALUES (${ownerId}, 'Europe/Stockholm', 'en', 'auto', '2026-08-16', '2026-08-16')
      `)
    )
    const selected = await runtime.runPromise(
      database.applicationStorage
        .select({ id: sql<string>`id` })
        .from(sql`users`)
        .where(sql`id = ${ownerId}`)
    )
    expect(selected).toEqual([{ id: ownerId }])
  })
})
