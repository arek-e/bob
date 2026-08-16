import type { BetterAuthOptions } from "better-auth"

import { drizzleAdapter } from "better-auth/adapters/drizzle"
import { drizzle as drizzleProxy } from "drizzle-orm/pg-proxy"
import { drizzle as drizzlePostgresql } from "drizzle-orm/postgres-js"
import { AsyncLocalStorage } from "node:async_hooks"
import postgres, { type Sql } from "postgres"

import type { CoreBatchQuery, CoreBatchResults, CoreDatabase } from "./database.ts"

import { authSchema } from "./auth-schema.ts"
import { postgresqlBaselineId, postgresqlBootstrapStatements } from "./postgresql-bootstrap.ts"

type QueryExecutor = Pick<Sql, "unsafe">

/** One native PostgreSQL Drizzle Module for application data and Better Auth. */
export interface PostgresqlDatabase {
  readonly applicationStorage: CoreDatabase
  readonly authDatabase: NonNullable<BetterAuthOptions["database"]>
  readonly migrate: () => Promise<void>
  readonly close: () => Promise<void>
}

/** Connect the complete database Module through one PostgreSQL pool. */
export function connectPostgresqlDatabase(
  url: string,
  options: { readonly maximumConnections?: number } = {}
): PostgresqlDatabase {
  const client = postgres(url, {
    max: options.maximumConnections ?? 10,
    transform: { undefined: null },
    onnotice: () => undefined
  })
  const activeTransaction = new AsyncLocalStorage<QueryExecutor>()
  const database = drizzleProxy(async (query, parameters, method) => {
    const executor = activeTransaction.getStore() ?? client
    const pending = executor.unsafe<Readonly<Record<string, unknown>>[]>(query, parameters)
    const rows = method === "all" ? await pending.values() : await pending
    return { rows: [...rows] }
  }) as CoreDatabase

  database.batch = (async <const Queries extends readonly CoreBatchQuery[]>(queries: Queries) => {
    const results = await client.begin((transaction) =>
      activeTransaction.run(transaction, async () => {
        const values: unknown[] = []
        for (const query of queries) {
          const executable = query as CoreBatchQuery & { execute(): Promise<unknown> }
          values.push(await executable.execute())
        }
        return values
      })
    )
    return results as CoreBatchResults<Queries>
  }) as CoreDatabase["batch"]

  const auth = drizzlePostgresql({ client })
  return {
    applicationStorage: database,
    authDatabase: drizzleAdapter(auth, { provider: "pg", schema: authSchema }),
    async migrate() {
      await client.begin(async (transaction) => {
        await transaction.unsafe(`
          CREATE TABLE IF NOT EXISTS bob_schema_migrations (
            id text PRIMARY KEY,
            applied_at timestamptz NOT NULL DEFAULT now()
          )
        `)
        await transaction.unsafe("SELECT pg_advisory_xact_lock(hashtext('bob-schema-migrations'))")
        const applied = await transaction.unsafe<{ readonly id: string }[]>(
          "SELECT id FROM bob_schema_migrations WHERE id = $1",
          [postgresqlBaselineId]
        )
        if (applied.length > 0) return

        for (const statement of postgresqlBootstrapStatements) {
          await transaction.unsafe(statement)
        }
        await transaction.unsafe("INSERT INTO bob_schema_migrations (id) VALUES ($1)", [
          postgresqlBaselineId
        ])
      })
    },
    close: () => client.end()
  }
}
