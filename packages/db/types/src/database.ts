import type { EffectPgDatabase } from "drizzle-orm/effect-postgres"

import { Effect } from "effect"

/** Native Effect PostgreSQL Drizzle database. */
export type CoreDatabase = EffectPgDatabase

/** Executable Drizzle query accepted by a database transaction. */
export interface DatabaseQuery<Result = unknown> {
  readonly _: { readonly result: Result }
}

type QueryResults<Queries extends readonly DatabaseQuery[]> = {
  -readonly [Index in keyof Queries]: Queries[Index]["_"]["result"]
}

/** Run database effects sequentially in one native Drizzle transaction. */
export function allInTransaction<const Queries extends readonly DatabaseQuery[]>(
  database: CoreDatabase,
  queries: Queries
) {
  return database.transaction(
    () =>
      Effect.all([...queries] as unknown as readonly Effect.Effect<unknown, unknown>[], {
        concurrency: 1
      }) as Effect.Effect<QueryResults<Queries>, unknown>
  )
}
