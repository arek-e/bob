import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    coverage: {
      enabled: false
    },
    include: [
      "apps/*/test/**/*.test.ts",
      "infra/*/test/**/*.test.ts",
      "packages/*/test/**/*.test.ts",
      "evals/deterministic/**/*.test.ts"
    ],
    passWithNoTests: false
  }
})
