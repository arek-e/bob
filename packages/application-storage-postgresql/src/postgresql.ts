import postgres from "postgres"

export type PostgresqlStorageValue = string | number | boolean | Uint8Array | Date | null
export type PostgresqlStorageRow = Readonly<Record<string, PostgresqlStorageValue>>

export interface PostgresqlStorageResult {
  readonly success: true
  readonly results: readonly PostgresqlStorageRow[]
  readonly meta: { readonly changes: number }
}

export interface PostgresqlPreparedStatement {
  readonly bind: (...values: readonly PostgresqlStorageValue[]) => PostgresqlPreparedStatement
  readonly all: () => Promise<PostgresqlStorageResult>
  readonly first: <Row extends PostgresqlStorageRow>() => Promise<Row | null>
  readonly raw: () => Promise<readonly (readonly PostgresqlStorageValue[])[]>
  readonly run: () => Promise<PostgresqlStorageResult>
}

interface SchemaTable {
  readonly name: string
  readonly entityType: "tables"
}

interface SchemaColumn {
  readonly table: string
  readonly name: string
  readonly type: string
  readonly notNull: boolean
  readonly default: string | number | boolean | null
  readonly entityType: "columns"
}

interface SchemaPrimaryKey {
  readonly table: string
  readonly name: string
  readonly columns: readonly string[]
  readonly entityType: "pks"
}

interface SchemaIndexColumn {
  readonly value: string
  readonly isExpression: boolean
}

interface SchemaIndex {
  readonly table: string
  readonly name: string
  readonly columns: readonly SchemaIndexColumn[]
  readonly isUnique: boolean
  readonly where: string | null
  readonly entityType: "indexes"
}

type SchemaEntity = SchemaTable | SchemaColumn | SchemaPrimaryKey | SchemaIndex

/** Compatibility input for the current PostgreSQL Adapter migration path. */
export interface PostgresqlSchemaSnapshot {
  readonly dialect: "sqlite"
  readonly ddl: readonly SchemaEntity[]
}

/** PostgreSQL Runtime Adapter for Module-owned application storage. */
export interface PostgresqlApplicationStorageAdapter {
  readonly prepare: (query: string) => PostgresqlPreparedStatement
  readonly batch: (
    statements: readonly PostgresqlPreparedStatement[]
  ) => Promise<readonly PostgresqlStorageResult[]>
  readonly migrate: (snapshot: PostgresqlSchemaSnapshot, additionalSql?: string) => Promise<void>
  readonly close: () => Promise<void>
}

function quoted(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`
}

function translatedDefault(column: SchemaColumn): string {
  const value = column.default
  if (value === null) return ""
  if (value === true) return " DEFAULT 1"
  if (value === false) return " DEFAULT 0"
  if (column.type.toLowerCase().includes("int") && value === "true") return " DEFAULT 1"
  if (column.type.toLowerCase().includes("int") && value === "false") return " DEFAULT 0"
  return ` DEFAULT ${String(value).replaceAll("`", '"')}`
}

export function postgresSchemaSql(snapshot: PostgresqlSchemaSnapshot): readonly string[] {
  const columns = snapshot.ddl.filter(
    (entity): entity is SchemaColumn => entity.entityType === "columns"
  )
  const primaryKeys = snapshot.ddl.filter(
    (entity): entity is SchemaPrimaryKey => entity.entityType === "pks"
  )
  const tables = snapshot.ddl.filter(
    (entity): entity is SchemaTable => entity.entityType === "tables"
  )
  const indexes = snapshot.ddl.filter(
    (entity): entity is SchemaIndex => entity.entityType === "indexes"
  )
  const statements = tables.map((table) => {
    const definitions = columns
      .filter((column) => column.table === table.name)
      .map((column) => {
        const type = column.type.toLowerCase().includes("int") ? "integer" : "text"
        return `${quoted(column.name)} ${type}${column.notNull ? " NOT NULL" : ""}${translatedDefault(column)}`
      })
    const primaryKey = primaryKeys.find((entry) => entry.table === table.name)
    if (primaryKey !== undefined) {
      definitions.push(
        `CONSTRAINT ${quoted(primaryKey.name)} PRIMARY KEY (${primaryKey.columns.map(quoted).join(", ")})`
      )
    }
    return `CREATE TABLE IF NOT EXISTS ${quoted(table.name)} (${definitions.join(", ")})`
  })
  for (const index of indexes) {
    const values = index.columns.map((column) =>
      column.isExpression ? column.value.replaceAll("`", '"') : quoted(column.value)
    )
    const where = index.where === null ? "" : ` WHERE ${index.where.replaceAll("`", '"')}`
    statements.push(
      `CREATE ${index.isUnique ? "UNIQUE " : ""}INDEX IF NOT EXISTS ${quoted(index.name)} ON ${quoted(index.table)} (${values.join(", ")})${where}`
    )
  }
  return statements
}

export function translateSqliteQuery(query: string): string {
  let parameter = 0
  return query
    .replaceAll("`", '"')
    .replace(/\?/gu, () => `$${++parameter}`)
    .replace(/\bmax\s*\(/giu, "greatest(")
    .replace(/^insert\s+or\s+ignore\s+/iu, "insert ")
    .replace(
      /retrieval_documents_fts\s+MATCH\s+(\$\d+)/giu,
      "to_tsvector('simple', f.search_text || ' ' || f.source_label) @@ websearch_to_tsquery('simple', $1)"
    )
    .replace(/bm25\(retrieval_documents_fts\),\s*/giu, "")
    .replace(
      /on\s+conflict\s+\(([^)]*)\)/giu,
      (_match, columns: string) =>
        `on conflict (${columns.replace(/"[^"]+"\."([^"]+)"/gu, '"$1"')})`
    )
}

/** Create the PostgreSQL Runtime Adapter for Module-owned storage. */
export function createPostgresqlApplicationStorageAdapter(
  url: string,
  options: { readonly maximumConnections?: number } = {}
): PostgresqlApplicationStorageAdapter {
  const sql = postgres(url, {
    max: options.maximumConnections ?? 10,
    transform: { undefined: null },
    onnotice: () => undefined
  })
  const statementInputs = new WeakMap<
    PostgresqlPreparedStatement,
    { readonly query: string; readonly values: readonly PostgresqlStorageValue[] }
  >()

  function prepareWithExecutor(
    query: string,
    values: readonly PostgresqlStorageValue[],
    executor: { readonly unsafe: typeof sql.unsafe }
  ): PostgresqlPreparedStatement {
    async function execute(): Promise<PostgresqlStorageResult> {
      const rows = await executor.unsafe<PostgresqlStorageRow[]>(translateSqliteQuery(query), [
        ...values
      ])
      return {
        success: true,
        results: [...rows],
        meta: { changes: rows.count }
      }
    }
    const statement: PostgresqlPreparedStatement = {
      bind: (...nextValues) => prepareWithExecutor(query, nextValues, executor),
      all: execute,
      async first<Row extends PostgresqlStorageRow>() {
        const result = await execute()
        // SAFETY: The caller supplies the row shape that its reviewed SQL selects.
        return (result.results[0] as Row | undefined) ?? null
      },
      async raw() {
        const result = await execute()
        return result.results.map((row) => Object.values(row))
      },
      run: execute
    }
    statementInputs.set(statement, { query, values })
    return statement
  }

  return {
    prepare: (query) => prepareWithExecutor(query, [], sql),
    async batch(statements) {
      return sql.begin(async (transaction) => {
        const results: PostgresqlStorageResult[] = []
        for (const statement of statements) {
          const input = statementInputs.get(statement)
          if (input === undefined) throw new TypeError("Foreign prepared statement")
          results.push(await prepareWithExecutor(input.query, input.values, transaction).run())
        }
        return results
      })
    },
    async migrate(snapshot, additionalSql = "") {
      await sql.begin(async (transaction) => {
        for (const statement of postgresSchemaSql(snapshot)) await transaction.unsafe(statement)
        if (additionalSql.trim().length > 0) await transaction.unsafe(additionalSql)
      })
    },
    close: () => sql.end()
  }
}
