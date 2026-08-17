import { sql } from "drizzle-orm"
import {
  bigint,
  boolean,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex
} from "drizzle-orm/pg-core"

export const auth_user = pgTable(
  "auth_user",
  {
    id: text("id")
      .primaryKey()
      .default(sql`gen_random_uuid()::text`),
    name: text("name").notNull(),
    email: text("email").notNull(),
    email_verified: boolean("email_verified").notNull(),
    image: text("image"),
    created_at: timestamp("created_at", { withTimezone: true }).notNull(),
    updated_at: timestamp("updated_at", { withTimezone: true }).notNull()
  },
  (table) => [uniqueIndex("auth_user_email_uq").on(table.email)]
)

export const auth_session = pgTable(
  "auth_session",
  {
    id: text("id")
      .primaryKey()
      .default(sql`gen_random_uuid()::text`),
    expires_at: timestamp("expires_at", { withTimezone: true }).notNull(),
    token: text("token").notNull(),
    created_at: timestamp("created_at", { withTimezone: true }).notNull(),
    updated_at: timestamp("updated_at", { withTimezone: true }).notNull(),
    ip_address: text("ip_address"),
    user_agent: text("user_agent"),
    user_id: text("user_id")
      .notNull()
      .references(() => auth_user.id, { onDelete: "cascade" })
  },
  (table) => [
    uniqueIndex("auth_session_token_uq").on(table.token),
    index("auth_session_user_id_idx").on(table.user_id)
  ]
)

export const auth_account = pgTable(
  "auth_account",
  {
    id: text("id")
      .primaryKey()
      .default(sql`gen_random_uuid()::text`),
    account_id: text("account_id").notNull(),
    provider_id: text("provider_id").notNull(),
    user_id: text("user_id")
      .notNull()
      .references(() => auth_user.id, { onDelete: "cascade" }),
    access_token: text("access_token"),
    refresh_token: text("refresh_token"),
    id_token: text("id_token"),
    access_token_expires_at: timestamp("access_token_expires_at", { withTimezone: true }),
    refresh_token_expires_at: timestamp("refresh_token_expires_at", { withTimezone: true }),
    scope: text("scope"),
    password: text("password"),
    created_at: timestamp("created_at", { withTimezone: true }).notNull(),
    updated_at: timestamp("updated_at", { withTimezone: true }).notNull()
  },
  (table) => [index("auth_account_user_id_idx").on(table.user_id)]
)

export const auth_verification = pgTable(
  "auth_verification",
  {
    id: text("id")
      .primaryKey()
      .default(sql`gen_random_uuid()::text`),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expires_at: timestamp("expires_at", { withTimezone: true }).notNull(),
    created_at: timestamp("created_at", { withTimezone: true }).notNull(),
    updated_at: timestamp("updated_at", { withTimezone: true }).notNull()
  },
  (table) => [index("auth_verification_identifier_idx").on(table.identifier)]
)

export const auth_rate_limit = pgTable(
  "auth_rate_limit",
  {
    id: text("id")
      .primaryKey()
      .default(sql`gen_random_uuid()::text`),
    key: text("key").notNull(),
    count: integer("count").notNull(),
    last_request: bigint("last_request", { mode: "number" }).notNull()
  },
  (table) => [uniqueIndex("auth_rate_limit_key_uq").on(table.key)]
)

export const betterAuthSchema = {
  auth_user,
  auth_session,
  auth_account,
  auth_verification,
  auth_rate_limit
} as const
