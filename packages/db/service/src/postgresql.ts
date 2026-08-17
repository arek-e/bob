import type { CoreDatabase } from "@bob/db-types"
import type { BetterAuthOptions } from "better-auth"

import * as PgClient from "@effect/sql-pg/PgClient"
import { drizzleAdapter } from "better-auth/adapters/drizzle"
import * as PgDrizzle from "drizzle-orm/effect-postgres"
import * as PgMigrator from "drizzle-orm/effect-postgres/migrator"
import { readMigrationFiles } from "drizzle-orm/migrator"
import { drizzle as drizzlePostgresql } from "drizzle-orm/node-postgres"
import { Context, Effect, Layer } from "effect"
import * as Reactivity from "effect/unstable/reactivity/Reactivity"
import { Pool } from "pg"

import { betterAuthSchema } from "./schema/auth.ts"

const legacyMigrationTable = "public.bob_schema_migrations"
const baselineMigrationName = "20260816201429_dashing_blue_marvel"

export interface PostgresqlDatabaseOptions {
  readonly maximumConnections?: number
  readonly migrationsFolder: string
}

export interface PostgresqlDatabaseShape {
  readonly applicationStorage: CoreDatabase
  readonly authDatabase: NonNullable<BetterAuthOptions["database"]>
  readonly migrate: Effect.Effect<void, unknown>
}

/** Scoped PostgreSQL resources for application storage and Better Auth. */
export class PostgresqlDatabase extends Context.Service<
  PostgresqlDatabase,
  PostgresqlDatabaseShape
>()("@bob/db/PostgresqlDatabase") {}

function acquirePool(url: string, maximumConnections: number) {
  return Effect.acquireRelease(
    Effect.sync(
      () =>
        new Pool({
          connectionString: url,
          max: maximumConnections
        })
    ),
    (pool) => Effect.promise(() => pool.end())
  )
}

function migrationProgram(
  database: Effect.Success<ReturnType<typeof PgDrizzle.makeWithDefaults>>,
  migrationsFolder: string
): Effect.Effect<void, unknown> {
  const sql = database.$client
  return sql.withTransaction(
    Effect.gen(function* () {
      yield* sql.unsafe("SELECT pg_advisory_xact_lock(hashtext('bob-schema-migrations'))")
      const migrations = yield* Effect.try({
        try: () => readMigrationFiles({ migrationsFolder }),
        catch: (cause) =>
          new Error(`Could not read PostgreSQL migrations from ${migrationsFolder}`, { cause })
      })
      const baseline = migrations.find((migration) => migration.name === baselineMigrationName)
      if (baseline === undefined) {
        return yield* Effect.fail(
          new Error(`PostgreSQL baseline migration ${baselineMigrationName} is missing`)
        )
      }

      const [legacyTable] = yield* sql.unsafe<{ readonly table_name: string | null }>(
        "SELECT to_regclass($1)::text AS table_name",
        [legacyMigrationTable]
      )
      if (legacyTable?.table_name !== null && legacyTable?.table_name !== undefined) {
        const applied = yield* sql.unsafe<{ readonly id: string }>(
          `SELECT id FROM ${legacyMigrationTable} WHERE id = $1`,
          [baselineMigrationName]
        )
        if (applied.length > 0) {
          yield* sql.unsafe("CREATE SCHEMA IF NOT EXISTS drizzle")
          yield* sql.unsafe(`
            CREATE TABLE IF NOT EXISTS drizzle.__drizzle_migrations (
              id SERIAL PRIMARY KEY,
              hash text NOT NULL,
              created_at bigint,
              name text,
              applied_at timestamp with time zone DEFAULT now()
            )
          `)
          yield* sql.unsafe(
            `INSERT INTO drizzle.__drizzle_migrations (hash, created_at, name)
             SELECT $1, $2, $3
             WHERE NOT EXISTS (
               SELECT 1 FROM drizzle.__drizzle_migrations WHERE name = $3
             )`,
            [baseline.hash, baseline.folderMillis, baseline.name]
          )
        }
      }

      yield* PgMigrator.migrate(database, { migrationsFolder })
    })
  )
}

/** Build the database Module from one scoped PostgreSQL pool. */
export function postgresqlDatabaseLayer(url: string, options: PostgresqlDatabaseOptions) {
  return Layer.effect(
    PostgresqlDatabase,
    Effect.gen(function* () {
      const pool = yield* acquirePool(url, options.maximumConnections ?? 10)
      const client = yield* PgClient.fromPool({ acquire: Effect.succeed(pool) }).pipe(
        Effect.provide(Reactivity.layer)
      )
      const database = yield* PgDrizzle.makeWithDefaults().pipe(
        Effect.provideService(PgClient.PgClient, client)
      )
      const applicationStorage: CoreDatabase = database
      const auth = drizzlePostgresql({ client: pool })
      return PostgresqlDatabase.of({
        applicationStorage,
        authDatabase: drizzleAdapter(auth, { provider: "pg", schema: betterAuthSchema }),
        migrate: migrationProgram(database, options.migrationsFolder)
      })
    })
  )
}
