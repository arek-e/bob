import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    coverage: {
      enabled: false
    },
    include: [
      "apps/*/test/**/*.test.ts",
      "packages/sendblue-channel/*/test/**/*.test.ts",
      "iac/*/test/**/*.test.ts",
      "packages/*/test/**/*.test.ts"
    ],
    passWithNoTests: false
  }
})
