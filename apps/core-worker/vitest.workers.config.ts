import { cloudflareTest } from "@cloudflare/vitest-pool-workers"
import { readdir, readFile } from "node:fs/promises"
import { resolve } from "node:path"
import { defineConfig } from "vitest/config"

async function readNestedMigrations() {
  const root = resolve(import.meta.dirname, "migrations")
  const entries = await readdir(root, { withFileTypes: true })
  return Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .sort((left, right) => left.name.localeCompare(right.name))
      .map(async (entry) => {
        const sql = await readFile(resolve(root, entry.name, "migration.sql"), "utf8")
        return {
          name: entry.name,
          queries: sql
            .split(/\s*-->\s*statement-breakpoint\s*/u)
            .map((query) => query.trim())
            .filter((query) => query.length > 0)
        }
      })
  )
}

function testKey(byte: number): string {
  return Buffer.from(new Uint8Array(32).fill(byte)).toString("hex")
}

export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      main: "src/index.ts",
      miniflare: {
        compatibilityDate: "2026-08-10",
        compatibilityFlags: ["nodejs_compat"],
        d1Databases: ["DB"],
        r2Buckets: ["PRIVATE_OBJECTS"],
        queueProducers: {
          OUTBOUND_QUEUE: "bob-outbound-test",
          DELIVERY_RESULT_QUEUE: "bob-delivery-result-test"
        },
        durableObjects: {
          OWNER_RUN_COORDINATOR: "OwnerRunCoordinator",
          REMINDER_CLOCK: "ReminderClock"
        },
        bindings: {
          TEST_MIGRATIONS: JSON.stringify(await readNestedMigrations()),
          INBOUND_DEAD_LETTER_QUEUE_NAME: "bob-inbound-dead-letter-test",
          DELIVERY_RESULT_QUEUE_NAME: "bob-delivery-result-test",
          DELIVERY_RESULT_DEAD_LETTER_QUEUE_NAME: "bob-delivery-result-dead-letter-test",
          OUTBOUND_DEAD_LETTER_QUEUE_NAME: "bob-outbound-dead-letter-test",
          OWNER_ID: "00000000-0000-4000-8000-000000000001",
          OWNER_TIME_ZONE: "Europe/Stockholm",
          REMINDER_QUIET_HOURS_START: "22:00",
          REMINDER_QUIET_HOURS_END: "07:00",
          REMINDER_DAILY_LIMIT: 8,
          DATA_KEK_ACTIVE_VERSION: "1",
          DATA_KEK_KEYRING_JSON: JSON.stringify({ 1: testKey(1) }),
          DATA_LOOKUP_KEY: testKey(2),
          INGRESS_CALLER_SECRET: "ingress-caller-secret-at-least-32-bytes",
          EGRESS_CALLER_SECRET: "egress-caller-secret-at-least-32-bytes",
          SENDBLUE_EGRESS_URL: "https://sendblue-egress.example.invalid",
          BETTER_AUTH_SECRET: "test-better-auth-secret-at-least-32-bytes",
          ACCESS_TEAM_DOMAIN: "example.cloudflareaccess.com",
          CORE_ACCESS_AUDIENCE: "core-test-audience",
          SETUP_ACCESS_AUDIENCE: "setup-test-audience",
          OWNER_ACCESS_EMAIL: "owner@example.invalid",
          AGENT_CALLER_SUBJECT: "agent-to-core-test-subject",
          AGENT_URL: "https://agent.example.invalid",
          AGENT_ACCESS_CLIENT_ID: "agent-run-client-id",
          AGENT_ACCESS_CLIENT_SECRET: "agent-run-client-secret-at-least-32-bytes",
          AGENT_ADMIN_URL: "https://agent-admin.example.invalid",
          AGENT_ADMIN_ACCESS_CLIENT_ID: "agent-admin-client-id",
          AGENT_ADMIN_ACCESS_CLIENT_SECRET: "agent-admin-secret-at-least-32-bytes",
          UI_BASE_URL: "https://bob.example.invalid",
          CONNECTIONS_GATEWAY_URL: "https://connections.example.invalid",
          CONNECTIONS_GATEWAY_ACCESS_CLIENT_ID: "connections-client-id",
          CONNECTIONS_GATEWAY_ACCESS_CLIENT_SECRET: "connections-client-secret",
          BOB_MODEL: "gpt-test",
          BOB_PROVIDER: "openai-codex",
          BOB_RUN_TOKEN_BUDGET: 32_000,
          BOB_DAILY_TOKEN_BUDGET: 250_000
        }
      }
    }))
  ],
  test: {
    include: ["test-workers/**/*.test.ts"],
    passWithNoTests: false
  }
})
