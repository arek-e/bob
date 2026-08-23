import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    coverage: {
      enabled: false
    },
    include: [
      "apps/*/test/**/*.test.ts",
      "iac/*/test/**/*.test.ts",
      "packages/**/test/**/*.test.ts",
      "tools/test/**/*.test.ts",
      "tools/test/**/*.test.tsx"
    ],
    passWithNoTests: false
  }
})
