import baselineSql from "../migrations/20260816201429_dashing_blue_marvel/migration.sql?raw"

export const postgresqlBaselineId = "20260816201429_dashing_blue_marvel"

const searchIndexSql = `
CREATE INDEX search_documents_full_text_idx
ON search_documents
USING gin (to_tsvector('simple', search_text || ' ' || source_label))
`

/** One reset-only PostgreSQL baseline split into transactional statements. */
export const postgresqlBootstrapStatements = [
  ...baselineSql
    .split(/\s*-->\s*statement-breakpoint\s*/u)
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0),
  searchIndexSql.trim()
] as const
