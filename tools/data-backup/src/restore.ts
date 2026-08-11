import { AwsClient } from "aws4fetch"
import { readdir, readFile } from "node:fs/promises"
import { resolve } from "node:path"

import {
  sha256,
  tableHash,
  type BackupArchive,
  type BackupRow,
  type BackupTable
} from "./archive.ts"
import { DEFAULT_REQUEST_TIMEOUT_MS, requestTimeoutSignal } from "./request.ts"

interface CloudflareEnvelope<T> {
  readonly success?: boolean
  readonly result?: T
}

interface D1DatabaseResult {
  readonly uuid?: string
  readonly jurisdiction?: string
}

interface R2BucketResult {
  readonly name?: string
  readonly jurisdiction?: string
}

interface QueryResult {
  readonly success?: boolean
  readonly results?: readonly Record<string, unknown>[]
}

export interface RestoreDrillOptions {
  readonly accountId: string
  readonly apiToken: string
  readonly migrationsDirectory: string
  readonly databasePrefix: string
  readonly r2BucketPrefix: string
  readonly r2Endpoint: string
  readonly r2AccessKeyId: string
  readonly r2SecretAccessKey: string
  readonly fetch?: typeof fetch
  readonly now?: () => Date
  readonly randomUuid?: () => string
  readonly requestTimeoutMs?: number
}

export interface RestoreDrillReport {
  readonly status: "completed"
  readonly databaseDeleted: true
  readonly bucketDeleted: true
  readonly tableCount: number
  readonly rowCount: number
  readonly objectCount: number
  readonly recoveryPointSeconds: number
  readonly recoveryTimeSeconds: number
}

const RESTORE_ORDER = [
  "users",
  "auth_user",
  "auth_account",
  "auth_session",
  "auth_verification",
  "auth_rate_limit",
  "external_connections",
  "user",
  "account",
  "session",
  "verification",
  "rateLimit",
  "channels",
  "messages",
  "message_events",
  "inbound_events",
  "agent_runs",
  "agent_run_attempts",
  "tool_calls",
  "training_proposals",
  "agent_usage",
  "effect_attempts",
  "audit_events",
  "provider_events",
  "journal_handoffs",
  "journal_entries",
  "attachments",
  "facts",
  "fact_revisions",
  "fact_evidence",
  "fact_relations",
  "memory_candidates",
  "gyms",
  "exercises",
  "equipment",
  "equipment_exercises",
  "routines",
  "routine_steps",
  "workout_sessions",
  "workout_sets",
  "reminders",
  "reminder_occurrences",
  "reminder_actions",
  "scheduler_outbox",
  "outbox_messages",
  "delivery_attempts",
  "short_reply_bindings",
  "operational_alerts"
] as const

const restorePriority: ReadonlyMap<string, number> = new Map(
  RESTORE_ORDER.map((name, index) => [name, index])
)

interface TableDependency {
  readonly table: string
  readonly parent: string
}

interface MigrationPlan {
  readonly statements: readonly string[]
  readonly deferredStatements: readonly string[]
  readonly dependencies: readonly TableDependency[]
  readonly migrationNames: readonly string[]
}

function compareTableNames(left: string, right: string): number {
  const leftPriority = restorePriority.get(left) ?? RESTORE_ORDER.length
  const rightPriority = restorePriority.get(right) ?? RESTORE_ORDER.length
  return leftPriority - rightPriority || left.localeCompare(right)
}

export function orderTablesForRestore(
  tables: readonly BackupTable[],
  dependencies: readonly TableDependency[] = []
): readonly BackupTable[] {
  const tablesByName = new Map(tables.map((table) => [table.name, table]))
  if (tablesByName.size !== tables.length) throw new Error("Backup contains duplicate tables")
  const children = new Map<string, Set<string>>()
  const dependencyCount = new Map(tables.map((table) => [table.name, 0]))
  for (const dependency of dependencies) {
    if (
      dependency.table === dependency.parent ||
      !tablesByName.has(dependency.table) ||
      !tablesByName.has(dependency.parent)
    ) {
      continue
    }
    const parentChildren = children.get(dependency.parent) ?? new Set<string>()
    if (!parentChildren.has(dependency.table)) {
      parentChildren.add(dependency.table)
      children.set(dependency.parent, parentChildren)
      dependencyCount.set(dependency.table, (dependencyCount.get(dependency.table) ?? 0) + 1)
    }
  }
  const ready = tables
    .map((table) => table.name)
    .filter((name) => dependencyCount.get(name) === 0)
    .sort(compareTableNames)
  const ordered: BackupTable[] = []
  while (ready.length > 0) {
    const name = ready.shift()!
    ordered.push(tablesByName.get(name)!)
    for (const child of children.get(name) ?? []) {
      const remaining = (dependencyCount.get(child) ?? 0) - 1
      dependencyCount.set(child, remaining)
      if (remaining === 0) {
        ready.push(child)
        ready.sort(compareTableNames)
      }
    }
  }
  if (ordered.length !== tables.length) {
    throw new Error("Backup table dependencies contain a cycle")
  }
  return ordered
}

function objectUrl(endpoint: string, bucket: string, key: string): string {
  const base = endpoint.replace(/\/$/u, "")
  const encodedKey = key.split("/").map(encodeURIComponent).join("/")
  return `${base}/${encodeURIComponent(bucket)}/${encodedKey}`
}

function safeIdentifier(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name)) {
    throw new Error("Backup contains an unsafe SQL identifier")
  }
  return `"${name}"`
}

function rowValue(value: unknown): BackupRow[string] {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value
  }
  if (
    Array.isArray(value) &&
    value.every((item) => Number.isInteger(item) && item >= 0 && item < 256)
  ) {
    return value as number[]
  }
  throw new Error("Restore drill D1 query returned an unsupported value")
}

function normalizeRow(row: Record<string, unknown>): BackupRow {
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [key, rowValue(value)]))
}

function unquotedIdentifier(match: RegExpMatchArray): string | undefined {
  return match[1] ?? match[2]
}

function statementDependencies(statement: string): readonly TableDependency[] {
  const ownerMatch = statement.match(
    /^\s*(?:CREATE\s+TABLE(?:\s+IF\s+NOT\s+EXISTS)?|ALTER\s+TABLE)\s+(?:[`"]([A-Za-z_][A-Za-z0-9_]*)[`"]|([A-Za-z_][A-Za-z0-9_]*))/iu
  )
  if (ownerMatch === null) return []
  const table = unquotedIdentifier(ownerMatch)
  if (table === undefined) return []
  const dependencies: TableDependency[] = []
  for (const reference of statement.matchAll(
    /\bREFERENCES\s+(?:[`"]([A-Za-z_][A-Za-z0-9_]*)[`"]|([A-Za-z_][A-Za-z0-9_]*))/giu
  )) {
    const parent = unquotedIdentifier(reference)
    if (parent !== undefined) dependencies.push({ table, parent })
  }
  return dependencies
}

function isTriggerStatement(statement: string): boolean {
  return /^\s*(?:CREATE|DROP)\s+TRIGGER\b/iu.test(statement)
}

async function readMigrations(directory: string): Promise<MigrationPlan> {
  const entries = await readdir(directory, { withFileTypes: true })
  const statements: string[] = []
  const migrationNames: string[] = []
  for (const entry of entries
    .filter((item) => item.isDirectory())
    .sort((left, right) => left.name.localeCompare(right.name))) {
    const source = await readFile(resolve(directory, entry.name, "migration.sql"), "utf8")
    migrationNames.push(`${entry.name}/migration.sql`)
    statements.push(
      ...source
        .split(/\s*-->\s*statement-breakpoint\s*/u)
        .map((statement) => statement.trim())
        .filter((statement) => statement.length > 0)
    )
  }
  if (statements.length === 0) throw new Error("No D1 migrations were loaded")
  return {
    statements: statements.filter((statement) => !isTriggerStatement(statement)),
    deferredStatements: statements.filter(isTriggerStatement),
    dependencies: statements.flatMap(statementDependencies),
    migrationNames
  }
}

function migrationLedgerStatements(
  migrationNames: readonly string[]
): readonly { sql: string; params: readonly unknown[] }[] {
  return [
    {
      sql: [
        'CREATE TABLE "d1_migrations" (',
        '  "id" TEXT PRIMARY KEY,',
        '  "name" TEXT NOT NULL,',
        '  "applied_at" TEXT NOT NULL',
        ")"
      ].join("\n"),
      params: []
    },
    ...migrationNames.map((name, index) => ({
      sql: [
        'INSERT INTO "d1_migrations" ("id", "name", "applied_at")',
        "VALUES (?, ?, datetime('now'))"
      ].join(" "),
      params: [(index + 1).toString().padStart(5, "0"), name]
    }))
  ]
}

function insertStatement(
  table: string,
  row: BackupRow
): { sql: string; params: readonly unknown[] } {
  const columns = Object.keys(row).sort((left, right) => left.localeCompare(right))
  if (columns.length === 0) throw new Error("Backup row has no columns")
  return {
    sql: `INSERT INTO ${safeIdentifier(table)} (${columns.map(safeIdentifier).join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
    params: columns.map((column) => row[column] ?? null)
  }
}

export function makeRestoreDrill(options: RestoreDrillOptions) {
  const request = options.fetch ?? fetch
  const now = options.now ?? (() => new Date())
  const randomUuid = options.randomUuid ?? (() => crypto.randomUUID())
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
  const accountBase = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(options.accountId)}/d1/database`
  const r2ControlBase = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(options.accountId)}/r2/buckets`
  const headers = {
    authorization: `Bearer ${options.apiToken}`,
    "content-type": "application/json"
  }
  const aws = new AwsClient({
    accessKeyId: options.r2AccessKeyId,
    secretAccessKey: options.r2SecretAccessKey,
    service: "s3",
    region: "auto"
  })

  function timedRequest(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const timeoutInit = { ...init, signal: requestTimeoutSignal(requestTimeoutMs) }
    return request(input instanceof Request ? new Request(input, timeoutInit) : input, timeoutInit)
  }

  async function signedR2Fetch(input: string, init?: RequestInit): Promise<Response> {
    return timedRequest(await aws.sign(input, init))
  }

  async function cloudflare<T>(url: string, init: RequestInit): Promise<T> {
    const response = await timedRequest(url, {
      ...init,
      headers: { ...headers, ...init.headers }
    })
    if (!response.ok)
      throw new Error(`Restore drill API request failed with status ${response.status}`)
    const body = (await response.json()) as CloudflareEnvelope<T>
    if (body.success !== true || body.result === undefined) {
      throw new Error("Restore drill API returned an invalid result")
    }
    return body.result
  }

  async function execute(
    databaseId: string,
    batch: readonly { sql: string; params: readonly unknown[] }[]
  ) {
    if (batch.length === 0) return
    const results = await cloudflare<readonly QueryResult[]>(
      `${accountBase}/${encodeURIComponent(databaseId)}/query`,
      { method: "POST", body: JSON.stringify({ batch }) }
    )
    if (results.some((result) => result.success !== true)) {
      throw new Error("Restore drill D1 batch failed")
    }
  }

  async function queryRows(databaseId: string, sql: string): Promise<readonly BackupRow[]> {
    const results = await cloudflare<readonly QueryResult[]>(
      `${accountBase}/${encodeURIComponent(databaseId)}/query`,
      { method: "POST", body: JSON.stringify({ sql, params: [] }) }
    )
    const result = results[0]
    if (result?.success !== true || !Array.isArray(result.results)) {
      throw new Error("Restore drill D1 query returned an invalid result")
    }
    return result.results.map(normalizeRow)
  }

  return {
    async run(archive: BackupArchive): Promise<RestoreDrillReport> {
      const startedAt = now()
      const suffix = randomUuid().replaceAll("-", "").slice(0, 12)
      const name = `${options.databasePrefix}-${suffix}`
      const bucketName = `${options.r2BucketPrefix}-${suffix}-objects`
      const created = await cloudflare<D1DatabaseResult>(accountBase, {
        method: "POST",
        body: JSON.stringify({
          name,
          jurisdiction: "eu",
          primary_location_hint: "weur",
          read_replication: { mode: "disabled" }
        })
      })
      if (created.uuid === undefined) {
        throw new Error("Restore drill database was not created in the EU jurisdiction")
      }
      const databaseId = created.uuid
      let deleted = false
      let bucketCreated = false
      let bucketDeleted = archive.objects.length === 0
      const writtenKeys: string[] = []
      let restoreFailed = false
      let restoreError: unknown
      let cleanupError: AggregateError | undefined
      try {
        if (created.jurisdiction !== "eu") {
          throw new Error("Restore drill database was not created in the EU jurisdiction")
        }
        const migrations = await readMigrations(options.migrationsDirectory)
        for (const statement of migrations.statements) {
          await execute(databaseId, [{ sql: statement, params: [] }])
        }
        for (const table of orderTablesForRestore(archive.tables, migrations.dependencies)) {
          const statements = table.rows.map((row) => insertStatement(table.name, row))
          for (let index = 0; index < statements.length; index += 25) {
            await execute(databaseId, statements.slice(index, index + 25))
          }
        }
        for (const statement of migrations.deferredStatements) {
          await execute(databaseId, [{ sql: statement, params: [] }])
        }
        await execute(databaseId, migrationLedgerStatements(migrations.migrationNames))
        for (const table of archive.tables) {
          const restoredRows = await queryRows(
            databaseId,
            `SELECT * FROM ${safeIdentifier(table.name)} ORDER BY rowid`
          )
          if (tableHash(restoredRows) !== table.sha256) {
            throw new Error("Restore drill table content does not match")
          }
        }
        if (archive.objects.length > 0) {
          const bucket = await cloudflare<R2BucketResult>(r2ControlBase, {
            method: "POST",
            headers: { "cf-r2-jurisdiction": "eu" },
            body: JSON.stringify({ name: bucketName, locationHint: "eeur" })
          })
          bucketCreated = true
          if (bucket.name !== bucketName || bucket.jurisdiction !== "eu") {
            throw new Error("Restore drill bucket was not created in the EU jurisdiction")
          }
          for (const object of archive.objects) {
            const bytes = Buffer.from(object.bytesBase64, "base64")
            const put = await signedR2Fetch(objectUrl(options.r2Endpoint, bucketName, object.key), {
              method: "PUT",
              headers: {
                "content-type": object.contentType ?? "application/octet-stream"
              },
              body: bytes
            })
            if (!put.ok) throw new Error(`Restore drill R2 write failed with status ${put.status}`)
            writtenKeys.push(object.key)
            const read = await signedR2Fetch(
              objectUrl(options.r2Endpoint, bucketName, object.key),
              { method: "GET" }
            )
            if (!read.ok || sha256(new Uint8Array(await read.arrayBuffer())) !== object.sha256) {
              throw new Error("Restore drill R2 object integrity check failed")
            }
          }
        }
      } catch (error) {
        restoreFailed = true
        restoreError = error
      } finally {
        const cleanupErrors: unknown[] = []
        for (const key of writtenKeys.toReversed()) {
          try {
            const response = await signedR2Fetch(objectUrl(options.r2Endpoint, bucketName, key), {
              method: "DELETE"
            })
            if (!response.ok) {
              cleanupErrors.push(new Error(`R2 delete failed with status ${response.status}`))
            }
          } catch (error) {
            cleanupErrors.push(error)
          }
        }
        if (bucketCreated) {
          try {
            await cloudflare<Record<string, never>>(
              `${r2ControlBase}/${encodeURIComponent(bucketName)}`,
              { method: "DELETE", headers: { "cf-r2-jurisdiction": "eu" } }
            )
            bucketDeleted = true
          } catch (error) {
            cleanupErrors.push(error)
          }
        }
        try {
          await cloudflare<Record<string, never>>(
            `${accountBase}/${encodeURIComponent(databaseId)}`,
            { method: "DELETE" }
          )
          deleted = true
        } catch (error) {
          cleanupErrors.push(error)
        }
        if (cleanupErrors.length > 0) {
          cleanupError = new AggregateError(
            restoreFailed ? [restoreError, ...cleanupErrors] : cleanupErrors,
            restoreFailed ? "Restore drill and cleanup failed" : "Restore drill cleanup failed"
          )
        }
      }
      if (cleanupError !== undefined) throw cleanupError
      if (restoreFailed) throw restoreError
      const finishedAt = now()
      if (!deleted || !bucketDeleted) throw new Error("Restore drill cleanup is incomplete")
      return {
        status: "completed",
        databaseDeleted: true,
        bucketDeleted: true,
        tableCount: archive.tables.length,
        rowCount: archive.tables.reduce((sum, table) => sum + table.rows.length, 0),
        objectCount: archive.objects.length,
        recoveryPointSeconds: Math.max(
          0,
          (startedAt.getTime() - Date.parse(archive.cutoffFinishedAt)) / 1_000
        ),
        recoveryTimeSeconds: Math.max(0, (finishedAt.getTime() - startedAt.getTime()) / 1_000)
      }
    }
  }
}
