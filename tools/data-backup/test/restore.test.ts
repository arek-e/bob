import { mkdtemp, mkdir, readdir, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

import { createArchive, sha256, tableHash } from "../src/archive.ts"
import { makeRestoreDrill, orderTablesForRestore } from "../src/restore.ts"

const migrationDirectory = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../apps/core-worker/migrations"
)

interface RestoreApiCall {
  url: string
  method: string
  body?: unknown
}

async function backedUpSchemaTables(): Promise<readonly string[]> {
  const names = new Set<string>()
  for (const entry of await readdir(migrationDirectory, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const source = await readFile(join(migrationDirectory, entry.name, "migration.sql"), "utf8")
    for (const match of source.matchAll(/CREATE TABLE\s+[`"]([A-Za-z_][A-Za-z0-9_]*)[`"]\s*\(/gu)) {
      const name = match[1]
      if (name !== undefined && name !== "search_documents") names.add(name)
    }
  }
  return [...names].sort((left, right) => left.localeCompare(right))
}

describe("isolated D1 restore drill", () => {
  it("orders every current backup table with Better Auth parents before their children", async () => {
    const table = (name: string) => ({ name, rows: [], sha256: tableHash([]) })
    const schemaTables = await backedUpSchemaTables()
    const ordered = orderTablesForRestore(schemaTables.map(table)).map(({ name }) => name)

    const expectedOrder = [
      "users",
      "auth_user",
      "auth_account",
      "auth_session",
      "auth_verification",
      "auth_rate_limit",
      "external_connections",
      "channels",
      "artifacts",
      "artifact_revisions",
      "messages",
      "message_events",
      "inbound_events",
      "conversation_turns",
      "conversation_turn_messages",
      "agent_runs",
      "agent_run_attempts",
      "agent_run_operations",
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
    ]

    expect(schemaTables).toHaveLength(48)
    expect(new Set(expectedOrder)).toEqual(new Set(schemaTables))
    expect(ordered).toEqual(expectedOrder)
    expect(ordered.indexOf("auth_user")).toBeLessThan(ordered.indexOf("auth_account"))
    expect(ordered.indexOf("auth_user")).toBeLessThan(ordered.indexOf("auth_session"))
    expect(ordered.indexOf("journal_handoffs")).toBeLessThan(ordered.indexOf("journal_entries"))
    expect(ordered.indexOf("artifacts")).toBeLessThan(ordered.indexOf("artifact_revisions"))
    expect(ordered.indexOf("workout_sessions")).toBeLessThan(ordered.indexOf("workout_sets"))
  })

  it("keeps the prior Better Auth table names foreign-key safe", () => {
    const table = (name: string) => ({ name, rows: [], sha256: tableHash([]) })

    expect(
      orderTablesForRestore(
        ["account", "rateLimit", "session", "user", "verification"].map(table)
      ).map(({ name }) => name)
    ).toEqual(["user", "account", "session", "verification", "rateLimit"])
  })

  it("orders trigger-dependent tables before their children", () => {
    const table = (name: string) => ({ name, rows: [], sha256: tableHash([]) })
    expect(
      orderTablesForRestore([
        table("workout_sets"),
        table("journal_entries"),
        table("journal_handoffs"),
        table("workout_sessions"),
        table("equipment"),
        table("routines"),
        table("routine_steps"),
        table("unrelated")
      ]).map(({ name }) => name)
    ).toEqual([
      "journal_handoffs",
      "journal_entries",
      "equipment",
      "routines",
      "routine_steps",
      "workout_sessions",
      "workout_sets",
      "unrelated"
    ])
  })

  it("restores migration-declared foreign key parents before their children", async () => {
    const directory = await mkdtemp(join(tmpdir(), "bob-restore-foreign-key-"))
    const migration = join(directory, "001_initial")
    await mkdir(migration)
    await writeFile(
      join(migration, "migration.sql"),
      [
        "CREATE TABLE zParent (id text PRIMARY KEY);",
        "--> statement-breakpoint",
        "CREATE TABLE aChild (id text PRIMARY KEY, parentId text NOT NULL REFERENCES zParent(id));"
      ].join("\n")
    )
    const parentRows = [{ id: "parent" }]
    const childRows = [{ id: "child", parentId: "parent" }]
    const archive = createArchive({
      createdAt: "2026-08-11T12:00:00.000Z",
      cutoffStartedAt: "2026-08-11T11:59:59.000Z",
      cutoffFinishedAt: "2026-08-11T12:00:00.000Z",
      source: { accountId: "account", databaseId: "source", bucket: "bucket" },
      tables: [
        { name: "aChild", rows: childRows, sha256: tableHash(childRows) },
        { name: "zParent", rows: parentRows, sha256: tableHash(parentRows) }
      ],
      objects: []
    })
    const insertedTables: string[] = []
    const fetchStub: typeof fetch = async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init)
      if (request.method === "POST" && request.url.endsWith("/d1/database")) {
        return Response.json({
          success: true,
          result: { uuid: "restore-id", jurisdiction: "eu" }
        })
      }
      if (request.method === "DELETE") {
        return Response.json({ success: true, result: {} })
      }
      // SAFETY: This controlled test fixture matches the asserted contract used by this test.
      const body = (await request.json()) as {
        readonly sql?: string
        readonly batch?: readonly { readonly sql: string }[]
      }
      if (body.sql?.startsWith('SELECT * FROM "aChild"') === true) {
        return Response.json({
          success: true,
          result: [{ success: true, results: childRows }]
        })
      }
      if (body.sql?.startsWith('SELECT * FROM "zParent"') === true) {
        return Response.json({
          success: true,
          result: [{ success: true, results: parentRows }]
        })
      }
      for (const statement of body.batch ?? []) {
        const table = statement.sql.match(/^INSERT INTO "([^"]+)"/u)?.[1]
        if (table !== undefined && table !== "d1_migrations") insertedTables.push(table)
      }
      return Response.json({
        success: true,
        result: (body.batch ?? []).map(() => ({ success: true, results: [] }))
      })
    }
    const drill = makeRestoreDrill({
      accountId: "account",
      apiToken: "write-token",
      migrationsDirectory: directory,
      databasePrefix: "bob-restore-drill",
      r2BucketPrefix: "bob-restore",
      r2Endpoint: "https://account.r2.cloudflarestorage.com",
      r2AccessKeyId: "restore-access",
      r2SecretAccessKey: "restore-secret",
      fetch: fetchStub
    })

    await drill.run(archive)

    expect(insertedTables).toEqual(["zParent", "aChild"])
  })

  it("creates validation triggers after restoring historical rows", async () => {
    const directory = await mkdtemp(join(tmpdir(), "bob-restore-trigger-"))
    const migration = join(directory, "001_initial")
    await mkdir(migration)
    await writeFile(
      join(migration, "migration.sql"),
      [
        "CREATE TABLE history (id text PRIMARY KEY, state text NOT NULL);",
        "--> statement-breakpoint",
        [
          "CREATE TRIGGER history_open_only BEFORE INSERT ON history",
          "WHEN NEW.state != 'open'",
          "BEGIN",
          "  SELECT RAISE(ABORT, 'historical_state_rejected');",
          "END;"
        ].join("\n")
      ].join("\n")
    )
    const rows = [{ id: "historical", state: "closed" }]
    const archive = createArchive({
      createdAt: "2026-08-11T12:00:00.000Z",
      cutoffStartedAt: "2026-08-11T11:59:59.000Z",
      cutoffFinishedAt: "2026-08-11T12:00:00.000Z",
      source: { accountId: "account", databaseId: "source", bucket: "bucket" },
      tables: [{ name: "history", rows, sha256: tableHash(rows) }],
      objects: []
    })
    const executedSql: string[] = []
    const fetchStub: typeof fetch = async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init)
      if (request.method === "POST" && request.url.endsWith("/d1/database")) {
        return Response.json({
          success: true,
          result: { uuid: "restore-id", jurisdiction: "eu" }
        })
      }
      if (request.method === "DELETE") {
        return Response.json({ success: true, result: {} })
      }
      // SAFETY: This controlled test fixture matches the asserted contract used by this test.
      const body = (await request.json()) as {
        readonly sql?: string
        readonly batch?: readonly { readonly sql: string }[]
      }
      if (body.sql?.startsWith('SELECT * FROM "history"') === true) {
        return Response.json({
          success: true,
          result: [{ success: true, results: rows }]
        })
      }
      executedSql.push(...(body.batch ?? []).map(({ sql }) => sql))
      return Response.json({
        success: true,
        result: (body.batch ?? []).map(() => ({ success: true, results: [] }))
      })
    }
    const drill = makeRestoreDrill({
      accountId: "account",
      apiToken: "write-token",
      migrationsDirectory: directory,
      databasePrefix: "bob-restore-drill",
      r2BucketPrefix: "bob-restore",
      r2Endpoint: "https://account.r2.cloudflarestorage.com",
      r2AccessKeyId: "restore-access",
      r2SecretAccessKey: "restore-secret",
      fetch: fetchStub
    })

    await drill.run(archive)

    const insertIndex = executedSql.findIndex((sql) => sql.startsWith('INSERT INTO "history"'))
    const triggerIndex = executedSql.findIndex((sql) => sql.startsWith("CREATE TRIGGER"))
    expect(insertIndex).toBeGreaterThan(-1)
    expect(triggerIndex).toBeGreaterThan(insertIndex)
  })

  it("records every applied migration in the Alchemy-compatible ledger", async () => {
    const directory = await mkdtemp(join(tmpdir(), "bob-restore-ledger-"))
    for (const [name, sql] of [
      ["001_initial", "CREATE TABLE first_table (id text PRIMARY KEY);"],
      ["002_more", "CREATE TABLE second_table (id text PRIMARY KEY);"]
    ] as const) {
      const migration = join(directory, name)
      await mkdir(migration)
      await writeFile(join(migration, "migration.sql"), sql)
    }
    const archive = createArchive({
      createdAt: "2026-08-11T12:00:00.000Z",
      cutoffStartedAt: "2026-08-11T11:59:59.000Z",
      cutoffFinishedAt: "2026-08-11T12:00:00.000Z",
      source: { accountId: "account", databaseId: "source", bucket: "bucket" },
      tables: [],
      objects: []
    })
    const batches: { readonly sql: string; readonly params?: readonly unknown[] }[][] = []
    const fetchStub: typeof fetch = async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init)
      if (request.method === "POST" && request.url.endsWith("/d1/database")) {
        return Response.json({
          success: true,
          result: { uuid: "restore-id", jurisdiction: "eu" }
        })
      }
      if (request.method === "DELETE") {
        return Response.json({ success: true, result: {} })
      }
      // SAFETY: This controlled test fixture matches the asserted contract used by this test.
      const body = (await request.json()) as {
        readonly batch?: readonly { readonly sql: string; readonly params?: readonly unknown[] }[]
      }
      batches.push([...(body.batch ?? [])])
      return Response.json({
        success: true,
        result: (body.batch ?? []).map(() => ({ success: true, results: [] }))
      })
    }
    const drill = makeRestoreDrill({
      accountId: "account",
      apiToken: "write-token",
      migrationsDirectory: directory,
      databasePrefix: "bob-restore-drill",
      r2BucketPrefix: "bob-restore",
      r2Endpoint: "https://account.r2.cloudflarestorage.com",
      r2AccessKeyId: "restore-access",
      r2SecretAccessKey: "restore-secret",
      fetch: fetchStub
    })

    await drill.run(archive)

    const statements = batches.flat()
    expect(statements.some(({ sql }) => sql.includes('CREATE TABLE "d1_migrations"'))).toBe(true)
    expect(
      statements
        .filter(({ sql }) => sql.startsWith('INSERT INTO "d1_migrations"'))
        .map(({ params }) => params)
    ).toEqual([
      ["00001", "001_initial/migration.sql"],
      ["00002", "002_more/migration.sql"]
    ])
  })

  it("restores rows, verifies content, and deletes the disposable EU database", async () => {
    const directory = await mkdtemp(join(tmpdir(), "bob-restore-test-"))
    const migration = join(directory, "001_initial")
    await mkdir(migration)
    await writeFile(
      join(migration, "migration.sql"),
      "CREATE TABLE users (id text PRIMARY KEY, name text NOT NULL);"
    )
    const rows = [{ id: "owner", name: "Encrypted owner" }]
    const objectBytes = Buffer.from("encrypted attachment")
    const archive = createArchive({
      createdAt: "2026-08-11T12:00:00.000Z",
      cutoffStartedAt: "2026-08-11T11:59:59.000Z",
      cutoffFinishedAt: "2026-08-11T12:00:00.000Z",
      source: { accountId: "account", databaseId: "source", bucket: "bucket" },
      tables: [{ name: "users", rows, sha256: tableHash(rows) }],
      objects: [
        {
          key: "journal/attachment.bin",
          contentType: "application/octet-stream",
          bytesBase64: objectBytes.toString("base64"),
          sha256: "aae86a1c1ad49bdd93c7828989ba1395c9629a8d36c791a3ee6fe5b366041d39"
        }
      ]
    })
    const calls: RestoreApiCall[] = []
    const fetchStub: typeof fetch = async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init)
      // SAFETY: This controlled test fixture matches the asserted contract used by this test.
      const body = request.method === "POST" ? ((await request.json()) as unknown) : undefined
      const call: RestoreApiCall = {
        url: request.url,
        method: request.method
      }
      if (body !== undefined) call.body = body
      calls.push(call)
      if (request.method === "POST" && request.url.endsWith("/d1/database")) {
        return Response.json({
          success: true,
          result: { uuid: "restore-id", jurisdiction: "eu" }
        })
      }
      if (request.method === "POST" && request.url.endsWith("/r2/buckets")) {
        return Response.json({
          success: true,
          result: { name: "bob-restore-000000000000-objects", jurisdiction: "eu" }
        })
      }
      if (request.url.includes("r2.cloudflarestorage.com")) {
        if (request.method === "GET") return new Response(objectBytes)
        return new Response(null, { status: 204 })
      }
      if (request.method === "DELETE") {
        return Response.json({ success: true, result: {} })
      }
      if (
        body instanceof Object &&
        "sql" in body &&
        String(body.sql).startsWith('SELECT * FROM "users"')
      ) {
        return Response.json({
          success: true,
          result: [{ success: true, results: rows }]
        })
      }
      return Response.json({ success: true, result: [{ success: true, results: [] }] })
    }
    const times = [new Date("2026-08-11T12:01:00.000Z"), new Date("2026-08-11T12:01:03.000Z")]
    const drill = makeRestoreDrill({
      accountId: "account",
      apiToken: "write-token",
      migrationsDirectory: directory,
      databasePrefix: "bob-restore-drill",
      r2BucketPrefix: "bob-restore",
      r2Endpoint: "https://account.r2.cloudflarestorage.com",
      r2AccessKeyId: "restore-access",
      r2SecretAccessKey: "restore-secret",
      fetch: fetchStub,
      now: () => times.shift() ?? new Date("2026-08-11T12:01:03.000Z"),
      randomUuid: () => "00000000-0000-4000-8000-000000000001"
    })

    await expect(drill.run(archive)).resolves.toEqual({
      status: "completed",
      databaseDeleted: true,
      bucketDeleted: true,
      tableCount: 1,
      rowCount: 1,
      objectCount: 1,
      recoveryPointSeconds: 60,
      recoveryTimeSeconds: 3
    })
    expect(calls.at(-1)).toMatchObject({ method: "DELETE" })
    expect(JSON.stringify(calls)).not.toContain("write-token")
    expect(JSON.stringify(calls)).not.toContain("restore-secret")
  })

  it("rejects restored table content that has the correct row count", async () => {
    const directory = await mkdtemp(join(tmpdir(), "bob-restore-content-"))
    const migration = join(directory, "001_initial")
    await mkdir(migration)
    await writeFile(
      join(migration, "migration.sql"),
      "CREATE TABLE users (id text PRIMARY KEY, name text NOT NULL);"
    )
    const rows = [{ id: "owner", name: "Expected owner" }]
    const archive = createArchive({
      createdAt: "2026-08-11T12:00:00.000Z",
      cutoffStartedAt: "2026-08-11T11:59:59.000Z",
      cutoffFinishedAt: "2026-08-11T12:00:00.000Z",
      source: { accountId: "account", databaseId: "source", bucket: "bucket" },
      tables: [{ name: "users", rows, sha256: tableHash(rows) }],
      objects: []
    })
    const fetchStub: typeof fetch = async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init)
      if (request.method === "POST" && request.url.endsWith("/d1/database")) {
        return Response.json({
          success: true,
          result: { uuid: "restore-id", jurisdiction: "eu" }
        })
      }
      if (request.method === "DELETE") {
        return Response.json({ success: true, result: {} })
      }
      // SAFETY: This controlled test fixture matches the asserted contract used by this test.
      const body = (await request.json()) as {
        readonly sql?: string
        readonly batch?: readonly unknown[]
      }
      if (body.sql?.includes("COUNT") === true) {
        return Response.json({
          success: true,
          result: [{ success: true, results: [{ count: 1 }] }]
        })
      }
      if (body.sql?.startsWith('SELECT * FROM "users"') === true) {
        return Response.json({
          success: true,
          result: [{ success: true, results: [{ id: "owner", name: "Changed owner" }] }]
        })
      }
      return Response.json({
        success: true,
        result: (body.batch ?? []).map(() => ({ success: true, results: [] }))
      })
    }
    const drill = makeRestoreDrill({
      accountId: "account",
      apiToken: "write-token",
      migrationsDirectory: directory,
      databasePrefix: "bob-restore-drill",
      r2BucketPrefix: "bob-restore",
      r2Endpoint: "https://account.r2.cloudflarestorage.com",
      r2AccessKeyId: "restore-access",
      r2SecretAccessKey: "restore-secret",
      fetch: fetchStub
    })

    await expect(drill.run(archive)).rejects.toThrow("table content does not match")
  })

  it("deletes the disposable database after a migration failure", async () => {
    const directory = await mkdtemp(join(tmpdir(), "bob-restore-failure-"))
    const migration = join(directory, "001_initial")
    await mkdir(migration)
    await writeFile(join(migration, "migration.sql"), "INVALID SQL;")
    const archive = createArchive({
      createdAt: "2026-08-11T12:00:00.000Z",
      cutoffStartedAt: "2026-08-11T11:59:59.000Z",
      cutoffFinishedAt: "2026-08-11T12:00:00.000Z",
      source: { accountId: "account", databaseId: "source", bucket: "bucket" },
      tables: [],
      objects: []
    })
    const methods: string[] = []
    const fetchStub: typeof fetch = async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init)
      methods.push(request.method)
      if (request.method === "POST" && request.url.endsWith("/d1/database")) {
        return Response.json({
          success: true,
          result: { uuid: "restore-id", jurisdiction: "eu" }
        })
      }
      if (request.method === "DELETE") {
        return Response.json({ success: true, result: {} })
      }
      return Response.json({ success: true, result: [{ success: false, results: [] }] })
    }
    const drill = makeRestoreDrill({
      accountId: "account",
      apiToken: "write-token",
      migrationsDirectory: directory,
      databasePrefix: "bob-restore-drill",
      r2BucketPrefix: "bob-restore",
      r2Endpoint: "https://account.r2.cloudflarestorage.com",
      r2AccessKeyId: "restore-access",
      r2SecretAccessKey: "restore-secret",
      fetch: fetchStub
    })

    await expect(drill.run(archive)).rejects.toThrow("D1 batch failed")
    expect(methods.at(-1)).toBe("DELETE")
  })

  it("deletes a created database when its EU jurisdiction check fails", async () => {
    const archive = createArchive({
      createdAt: "2026-08-11T12:00:00.000Z",
      cutoffStartedAt: "2026-08-11T11:59:59.000Z",
      cutoffFinishedAt: "2026-08-11T12:00:00.000Z",
      source: { accountId: "account", databaseId: "source", bucket: "bucket" },
      tables: [],
      objects: []
    })
    const methods: string[] = []
    const fetchStub: typeof fetch = async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init)
      methods.push(request.method)
      if (request.method === "POST") {
        return Response.json({
          success: true,
          result: { uuid: "restore-id", jurisdiction: "fedramp" }
        })
      }
      return Response.json({ success: true, result: {} })
    }
    const drill = makeRestoreDrill({
      accountId: "account",
      apiToken: "write-token",
      migrationsDirectory: "unused",
      databasePrefix: "bob-restore-drill",
      r2BucketPrefix: "bob-restore",
      r2Endpoint: "https://account.r2.cloudflarestorage.com",
      r2AccessKeyId: "restore-access",
      r2SecretAccessKey: "restore-secret",
      fetch: fetchStub
    })

    await expect(drill.run(archive)).rejects.toThrow("EU jurisdiction")
    expect(methods).toEqual(["POST", "DELETE"])
  })

  it("stops a restore control request that exceeds its time limit", async () => {
    const archive = createArchive({
      createdAt: "2026-08-11T12:00:00.000Z",
      cutoffStartedAt: "2026-08-11T11:59:59.000Z",
      cutoffFinishedAt: "2026-08-11T12:00:00.000Z",
      source: { accountId: "account", databaseId: "source", bucket: "bucket" },
      tables: [],
      objects: []
    })
    const fetchStub: typeof fetch = async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init)
      return new Promise<Response>((_resolve, reject) => {
        const rejectOnAbort = () => reject(request.signal.reason)
        if (request.signal.aborted) rejectOnAbort()
        else request.signal.addEventListener("abort", rejectOnAbort, { once: true })
      })
    }
    const drill = makeRestoreDrill({
      accountId: "account",
      apiToken: "write-token",
      migrationsDirectory: "unused",
      databasePrefix: "bob-restore-drill",
      r2BucketPrefix: "bob-restore",
      r2Endpoint: "https://account.r2.cloudflarestorage.com",
      r2AccessKeyId: "restore-access",
      r2SecretAccessKey: "restore-secret",
      fetch: fetchStub,
      requestTimeoutMs: 10
    })

    await expect(drill.run(archive)).rejects.toThrow(/timeout/iu)
  }, 250)

  it("stops a restore R2 request that exceeds its time limit", async () => {
    const directory = await mkdtemp(join(tmpdir(), "bob-restore-r2-timeout-"))
    const migration = join(directory, "001_initial")
    await mkdir(migration)
    await writeFile(join(migration, "migration.sql"), "CREATE TABLE users (id text PRIMARY KEY);")
    const bytes = Buffer.from("private object")
    const archive = createArchive({
      createdAt: "2026-08-11T12:00:00.000Z",
      cutoffStartedAt: "2026-08-11T11:59:59.000Z",
      cutoffFinishedAt: "2026-08-11T12:00:00.000Z",
      source: { accountId: "account", databaseId: "source", bucket: "bucket" },
      tables: [],
      objects: [
        {
          key: "object.bin",
          bytesBase64: bytes.toString("base64"),
          sha256: sha256(bytes)
        }
      ]
    })
    const fetchStub: typeof fetch = async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init)
      if (request.url.includes("r2.cloudflarestorage.com")) {
        return new Promise<Response>((_resolve, reject) => {
          const rejectOnAbort = () => reject(request.signal.reason)
          if (request.signal.aborted) rejectOnAbort()
          else request.signal.addEventListener("abort", rejectOnAbort, { once: true })
        })
      }
      if (request.method === "POST" && request.url.endsWith("/d1/database")) {
        return Response.json({
          success: true,
          result: { uuid: "restore-id", jurisdiction: "eu" }
        })
      }
      if (request.method === "POST" && request.url.endsWith("/r2/buckets")) {
        return Response.json({
          success: true,
          result: { name: "bob-restore-000000000000-objects", jurisdiction: "eu" }
        })
      }
      if (request.method === "DELETE") {
        return Response.json({ success: true, result: {} })
      }
      // SAFETY: This controlled test fixture matches the asserted contract used by this test.
      const body = (await request.json()) as { readonly batch?: readonly unknown[] }
      return Response.json({
        success: true,
        result: (body.batch ?? []).map(() => ({ success: true, results: [] }))
      })
    }
    const drill = makeRestoreDrill({
      accountId: "account",
      apiToken: "write-token",
      migrationsDirectory: directory,
      databasePrefix: "bob-restore-drill",
      r2BucketPrefix: "bob-restore",
      r2Endpoint: "https://account.r2.cloudflarestorage.com",
      r2AccessKeyId: "restore-access",
      r2SecretAccessKey: "restore-secret",
      fetch: fetchStub,
      requestTimeoutMs: 10,
      randomUuid: () => "00000000-0000-4000-8000-000000000001"
    })

    await expect(drill.run(archive)).rejects.toThrow(/timeout/iu)
  }, 300)

  it("deletes a created bucket when its EU jurisdiction check fails", async () => {
    const directory = await mkdtemp(join(tmpdir(), "bob-restore-bucket-location-"))
    const migration = join(directory, "001_initial")
    await mkdir(migration)
    await writeFile(join(migration, "migration.sql"), "CREATE TABLE users (id text PRIMARY KEY);")
    const bytes = Buffer.from("encrypted object")
    const archive = createArchive({
      createdAt: "2026-08-11T12:00:00.000Z",
      cutoffStartedAt: "2026-08-11T11:59:59.000Z",
      cutoffFinishedAt: "2026-08-11T12:00:00.000Z",
      source: { accountId: "account", databaseId: "source", bucket: "bucket" },
      tables: [],
      objects: [
        {
          key: "object.bin",
          bytesBase64: bytes.toString("base64"),
          sha256: sha256(bytes)
        }
      ]
    })
    const deletedUrls: string[] = []
    const fetchStub: typeof fetch = async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init)
      if (request.method === "POST" && request.url.endsWith("/d1/database")) {
        return Response.json({
          success: true,
          result: { uuid: "restore-id", jurisdiction: "eu" }
        })
      }
      if (request.method === "POST" && request.url.endsWith("/r2/buckets")) {
        return Response.json({
          success: true,
          result: { name: "bob-restore-000000000000-objects", jurisdiction: "fedramp" }
        })
      }
      if (request.method === "DELETE") {
        deletedUrls.push(request.url)
        return Response.json({ success: true, result: {} })
      }
      // SAFETY: This controlled test fixture matches the asserted contract used by this test.
      const body = (await request.json()) as { readonly batch?: readonly unknown[] }
      return Response.json({
        success: true,
        result: (body.batch ?? []).map(() => ({ success: true, results: [] }))
      })
    }
    const drill = makeRestoreDrill({
      accountId: "account",
      apiToken: "write-token",
      migrationsDirectory: directory,
      databasePrefix: "bob-restore-drill",
      r2BucketPrefix: "bob-restore",
      r2Endpoint: "https://account.r2.cloudflarestorage.com",
      r2AccessKeyId: "restore-access",
      r2SecretAccessKey: "restore-secret",
      fetch: fetchStub,
      randomUuid: () => "00000000-0000-4000-8000-000000000001"
    })

    await expect(drill.run(archive)).rejects.toThrow("EU jurisdiction")
    expect(deletedUrls).toEqual([
      "https://api.cloudflare.com/client/v4/accounts/account/r2/buckets/bob-restore-000000000000-objects",
      "https://api.cloudflare.com/client/v4/accounts/account/d1/database/restore-id"
    ])
  })

  it("reports both the restore failure and a cleanup failure", async () => {
    const directory = await mkdtemp(join(tmpdir(), "bob-restore-double-failure-"))
    const migration = join(directory, "001_initial")
    await mkdir(migration)
    await writeFile(join(migration, "migration.sql"), "INVALID SQL;")
    const archive = createArchive({
      createdAt: "2026-08-11T12:00:00.000Z",
      cutoffStartedAt: "2026-08-11T11:59:59.000Z",
      cutoffFinishedAt: "2026-08-11T12:00:00.000Z",
      source: { accountId: "account", databaseId: "source", bucket: "bucket" },
      tables: [],
      objects: []
    })
    const fetchStub: typeof fetch = async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init)
      if (request.method === "POST" && request.url.endsWith("/d1/database")) {
        return Response.json({
          success: true,
          result: { uuid: "restore-id", jurisdiction: "eu" }
        })
      }
      if (request.method === "DELETE") return new Response(null, { status: 500 })
      return Response.json({
        success: true,
        result: [{ success: false, results: [] }]
      })
    }
    const drill = makeRestoreDrill({
      accountId: "account",
      apiToken: "write-token",
      migrationsDirectory: directory,
      databasePrefix: "bob-restore-drill",
      r2BucketPrefix: "bob-restore",
      r2Endpoint: "https://account.r2.cloudflarestorage.com",
      r2AccessKeyId: "restore-access",
      r2SecretAccessKey: "restore-secret",
      fetch: fetchStub
    })

    const failure = await drill.run(archive).catch((error) => error)

    expect(failure).toBeInstanceOf(AggregateError)
    // SAFETY: This controlled test fixture matches the asserted contract used by this test.
    expect((failure as AggregateError).errors.map(String)).toEqual([
      "Error: Restore drill D1 batch failed",
      "Error: Restore drill API request failed with status 500"
    ])
  })
})
