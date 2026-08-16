import { describe, expect, it } from "vitest"

import type { PostgresqlSchemaSnapshot } from "../src/postgresql.ts"

import { postgresSchemaSql, translateSqliteQuery } from "../src/postgresql.ts"

describe("PostgreSQL Application Storage Adapter", () => {
  it("builds tables and indexes from the reviewed SQLite snapshot", () => {
    const snapshot: PostgresqlSchemaSnapshot = {
      dialect: "sqlite",
      ddl: [
        { name: "items", entityType: "tables" },
        {
          table: "items",
          name: "id",
          type: "text",
          notNull: true,
          default: null,
          entityType: "columns"
        },
        {
          table: "items",
          name: "enabled",
          type: "integer",
          notNull: true,
          default: "false",
          entityType: "columns"
        },
        {
          table: "items",
          name: "items_pk",
          columns: ["id"],
          entityType: "pks"
        },
        {
          table: "items",
          name: "items_enabled_idx",
          columns: [{ value: "enabled", isExpression: false }],
          isUnique: false,
          where: null,
          entityType: "indexes"
        }
      ]
    }

    expect(postgresSchemaSql(snapshot)).toEqual([
      'CREATE TABLE IF NOT EXISTS "items" ("id" text NOT NULL, "enabled" integer NOT NULL DEFAULT 0, CONSTRAINT "items_pk" PRIMARY KEY ("id"))',
      'CREATE INDEX IF NOT EXISTS "items_enabled_idx" ON "items" ("enabled")'
    ])
  })

  it("translates identifiers, parameters, and scalar maximum", () => {
    expect(
      translateSqliteQuery("update `turns` set `wake_at` = max(`wake_at`, ?) where `id` = ?")
    ).toBe('update "turns" set "wake_at" = greatest("wake_at", $1) where "id" = $2')
  })

  it("removes table qualifiers from PostgreSQL conflict targets", () => {
    expect(
      translateSqliteQuery(
        "insert into `usage` (`run_id`) values (?) on conflict (`usage`.`run_id`) do nothing"
      )
    ).toBe('insert into "usage" ("run_id") values ($1) on conflict ("run_id") do nothing')
  })
})
