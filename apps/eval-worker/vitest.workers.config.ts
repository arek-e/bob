import { cloudflareTest } from "@cloudflare/vitest-pool-workers"
import { readdir, readFile } from "node:fs/promises"
import { resolve } from "node:path"
import { defineConfig } from "vitest/config"

async function readMigrations() {
  const root = resolve(import.meta.dirname, "../../tools/agent-evals/migrations")
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

export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      main: "src/index.ts",
      miniflare: {
        compatibilityDate: "2026-08-10",
        d1Databases: ["EVAL_DB"],
        r2Buckets: ["EVAL_ARTIFACTS"],
        bindings: {
          BOB_RELEASE_SHA: "0000000000000000000000000000000000000000",
          TEST_MIGRATIONS: JSON.stringify(await readMigrations())
        }
      }
    }))
  ],
  test: {
    include: ["test-workers/**/*.test.ts"],
    passWithNoTests: false
  }
})
