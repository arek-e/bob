import { postgresqlDatabaseLayer, PostgresqlDatabase } from "@bob/db-service/postgresql"
import { Effect, ManagedRuntime } from "effect"
import { resolve } from "node:path"

const databaseUrl = process.env.DATABASE_URL
if (databaseUrl === undefined || databaseUrl.length === 0) {
  throw new Error("DATABASE_URL is required")
}

const runtime = ManagedRuntime.make(
  postgresqlDatabaseLayer(databaseUrl, {
    migrationsFolder: resolve(process.cwd(), "dist/migrations"),
    maximumConnections: 2
  })
)

try {
  await runtime.runPromise(Effect.flatMap(PostgresqlDatabase, (database) => database.migrate))
} finally {
  await runtime.dispose()
}
