import type { EffectPgDatabase } from "drizzle-orm/effect-postgres"

import { Effect } from "effect"

/** Native Effect PostgreSQL Drizzle database. */
export type CoreDatabase = EffectPgDatabase

/** Executable Drizzle query accepted by a database transaction. */
export interface DatabaseQuery<Result = unknown> {
  readonly _: { readonly result: Result }
}

type ExecutableDatabaseQuery<Result> = DatabaseQuery<Result> & Effect.Effect<Result, unknown>

type QueryResults<Queries extends readonly DatabaseQuery[]> = {
  -readonly [Index in keyof Queries]: Queries[Index]["_"]["result"]
}

function executableQuery<Result>(query: DatabaseQuery<Result>): ExecutableDatabaseQuery<Result> {
  // SAFETY: Native Drizzle query builders implement Effect but omit its members publicly.
  return query as ExecutableDatabaseQuery<Result>
}

/** Run database effects sequentially in one native Drizzle transaction. */
export function allInTransaction<const Queries extends readonly DatabaseQuery[]>(
  database: CoreDatabase,
  queries: Queries
) {
  const transaction = database.transaction(() =>
    Effect.all(queries.map(executableQuery), { concurrency: 1 })
  )
  // SAFETY: Array.map preserves the input order, so each result keeps its query index.
  return transaction as Effect.Effect<QueryResults<Queries>, unknown>
}
