import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    coverage: {
      enabled: false
    },
    include: [
      "apps/*/test/**/*.test.ts",
      "apps/sendblue-channel/*/test/**/*.test.ts",
      "infra/*/test/**/*.test.ts",
      "packages/*/test/**/*.test.ts",
      "tools/*/test/**/*.test.ts",
      "evals/deterministic/**/*.test.ts"
    ],
    passWithNoTests: false
  }
})
