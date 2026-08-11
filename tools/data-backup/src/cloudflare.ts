import { AwsClient } from "aws4fetch"

import {
  createArchive,
  sha256,
  tableHash,
  type BackupArchive,
  type BackupObject,
  type BackupRow,
  type BackupTable
} from "./archive.ts"
import { DEFAULT_REQUEST_TIMEOUT_MS, requestTimeoutSignal } from "./request.ts"

interface CloudflareEnvelope<T> {
  readonly success?: boolean
  readonly result?: T
  readonly errors?: readonly { readonly code?: number; readonly message?: string }[]
}

interface QueryResult {
  readonly success?: boolean
  readonly results?: readonly Record<string, unknown>[]
}

export interface BackupSourceOptions {
  readonly accountId: string
  readonly databaseId: string
  readonly apiToken: string
  readonly r2Bucket: string
  readonly r2Endpoint: string
  readonly r2AccessKeyId: string
  readonly r2SecretAccessKey: string
  readonly fetch?: typeof fetch
  readonly now?: () => Date
  readonly requestTimeoutMs?: number
}

const DERIVED_TABLES = new Set([
  "_cf_KV",
  "d1_migrations",
  "search_documents",
  "search_documents_fts",
  "search_documents_fts_config",
  "search_documents_fts_content",
  "search_documents_fts_data",
  "search_documents_fts_docsize",
  "search_documents_fts_idx"
])

function safeIdentifier(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name)) {
    throw new Error("D1 returned an unsafe table name")
  }
  return `"${name}"`
}

function rowValue(value: unknown): string | number | boolean | null | readonly number[] {
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
  throw new Error("D1 returned an unsupported value")
}

function normalizeRow(row: Record<string, unknown>): BackupRow {
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [key, rowValue(value)]))
}

function decodeXml(value: string): string {
  return value
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&")
}

function xmlValues(xml: string, tag: string): string[] {
  const escaped = tag.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")
  return [...xml.matchAll(new RegExp(`<${escaped}>([\\s\\S]*?)<\\/${escaped}>`, "gu"))].map(
    (match) => decodeXml(match[1] ?? "")
  )
}

function objectUrl(endpoint: string, bucket: string, key?: string): string {
  const base = endpoint.replace(/\/$/u, "")
  if (key === undefined) return `${base}/${encodeURIComponent(bucket)}`
  const encodedKey = key.split("/").map(encodeURIComponent).join("/")
  return `${base}/${encodeURIComponent(bucket)}/${encodedKey}`
}

export function makeCloudflareBackupSource(options: BackupSourceOptions) {
  const request = options.fetch ?? fetch
  const d1Base = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(options.accountId)}/d1/database/${encodeURIComponent(options.databaseId)}`
  const aws = new AwsClient({
    accessKeyId: options.r2AccessKeyId,
    secretAccessKey: options.r2SecretAccessKey,
    service: "s3",
    region: "auto"
  })
  const now = options.now ?? (() => new Date())
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS

  function timedRequest(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const timeoutInit = { ...init, signal: requestTimeoutSignal(requestTimeoutMs) }
    return request(input instanceof Request ? new Request(input, timeoutInit) : input, timeoutInit)
  }

  async function signedR2Fetch(input: string, init?: RequestInit): Promise<Response> {
    return timedRequest(await aws.sign(input, init))
  }

  async function query(
    sql: string,
    params: readonly unknown[] = []
  ): Promise<readonly BackupRow[]> {
    const response = await timedRequest(`${d1Base}/query`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${options.apiToken}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({ sql, params })
    })
    if (!response.ok) throw new Error(`D1 backup query failed with status ${response.status}`)
    const envelope = (await response.json()) as CloudflareEnvelope<readonly QueryResult[]>
    const result = envelope.result?.[0]
    if (envelope.success !== true || result?.success !== true || !Array.isArray(result.results)) {
      throw new Error("D1 backup query returned an invalid result")
    }
    return result.results.map(normalizeRow)
  }

  async function batchQuery(
    statements: readonly { readonly sql: string; readonly params: readonly unknown[] }[]
  ): Promise<readonly (readonly BackupRow[])[]> {
    if (statements.length === 0) return []
    const response = await timedRequest(`${d1Base}/query`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${options.apiToken}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({ batch: statements })
    })
    if (!response.ok) throw new Error(`D1 backup batch failed with status ${response.status}`)
    const envelope = (await response.json()) as CloudflareEnvelope<readonly QueryResult[]>
    if (
      envelope.success !== true ||
      !Array.isArray(envelope.result) ||
      envelope.result.length !== statements.length ||
      envelope.result.some((result) => result.success !== true || !Array.isArray(result.results))
    ) {
      throw new Error("D1 backup batch returned an invalid result")
    }
    return envelope.result.map((result) => result.results!.map(normalizeRow))
  }

  async function tableNames(): Promise<readonly string[]> {
    const rows = await query(
      "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
    )
    return rows
      .map((row) => row.name)
      .filter((name): name is string => typeof name === "string" && !DERIVED_TABLES.has(name))
  }

  async function exportTables(names: readonly string[]): Promise<readonly BackupTable[]> {
    if (names.length > 100) throw new Error("D1 backup has too many primary tables")
    const snapshots = await batchQuery(
      names.map((name) => ({
        sql: `SELECT * FROM ${safeIdentifier(name)} ORDER BY rowid`,
        params: []
      }))
    )
    return names.map((name, index) => {
      const rows = snapshots[index] ?? []
      return { name, rows, sha256: tableHash(rows) }
    })
  }

  async function listObjectKeys(): Promise<readonly { key: string; etag?: string }[]> {
    const objects: { key: string; etag?: string }[] = []
    let continuation: string | undefined
    do {
      const url = new URL(objectUrl(options.r2Endpoint, options.r2Bucket))
      url.searchParams.set("list-type", "2")
      url.searchParams.set("encoding-type", "url")
      url.searchParams.set("max-keys", "1000")
      if (continuation !== undefined) url.searchParams.set("continuation-token", continuation)
      const response = await signedR2Fetch(url.toString(), { method: "GET" })
      if (!response.ok) throw new Error(`R2 object listing failed with status ${response.status}`)
      const xml = await response.text()
      const keys = xmlValues(xml, "Key").map((key) => decodeURIComponent(key))
      const etags = xmlValues(xml, "ETag").map((etag) => etag.replace(/^"|"$/gu, ""))
      keys.forEach((key, index) => {
        objects.push({ key, ...(etags[index] === undefined ? {} : { etag: etags[index] }) })
      })
      const truncated = xmlValues(xml, "IsTruncated")[0] === "true"
      const next = xmlValues(xml, "NextContinuationToken")[0]
      continuation = truncated && next !== undefined ? decodeURIComponent(next) : undefined
    } while (continuation !== undefined)
    return objects
  }

  async function exportObject(input: { key: string; etag?: string }): Promise<BackupObject> {
    const response = await signedR2Fetch(
      objectUrl(options.r2Endpoint, options.r2Bucket, input.key),
      { method: "GET" }
    )
    if (!response.ok) throw new Error(`R2 object read failed with status ${response.status}`)
    const bytes = new Uint8Array(await response.arrayBuffer())
    return {
      key: input.key,
      ...(input.etag === undefined ? {} : { etag: input.etag }),
      ...(response.headers.get("content-type") === null
        ? {}
        : { contentType: response.headers.get("content-type")! }),
      bytesBase64: Buffer.from(bytes).toString("base64"),
      sha256: sha256(bytes)
    }
  }

  return {
    async export(): Promise<BackupArchive> {
      const cutoffStartedAt = now().toISOString()
      const tables = await exportTables(await tableNames())
      const objects: BackupObject[] = []
      for (const object of await listObjectKeys()) objects.push(await exportObject(object))
      const cutoffFinishedAt = now().toISOString()
      return createArchive({
        createdAt: cutoffFinishedAt,
        cutoffStartedAt,
        cutoffFinishedAt,
        source: {
          accountId: options.accountId,
          databaseId: options.databaseId,
          bucket: options.r2Bucket
        },
        tables,
        objects
      })
    }
  }
}
