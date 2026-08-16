import type { PgRemoteDatabase } from "drizzle-orm/pg-proxy"

export interface CoreBatchQuery<Result = unknown> {
  readonly _: { readonly result: Result }
}

export type CoreBatchResults<Queries extends readonly CoreBatchQuery[]> = {
  -readonly [Index in keyof Queries]: Queries[Index]["_"]["result"]
}

/** Native PostgreSQL Drizzle database with one transactional batch operation. */
export type CoreDatabase = PgRemoteDatabase & {
  batch<const Queries extends readonly CoreBatchQuery[]>(
    queries: Queries
  ): Promise<CoreBatchResults<Queries>>
}
