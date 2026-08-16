import { spawnSync } from "node:child_process"

import { discoverEnvironmentSchemaDirectories } from "./environment-schema-inventory.mjs"

const paths = discoverEnvironmentSchemaDirectories()

for (const path of paths) {
  const result = spawnSync("pnpm", ["exec", "varlock", "audit", "--path", ".", "."], {
    cwd: path,
    stdio: "inherit"
  })
  if (result.status !== 0) process.exit(result.status ?? 1)
}
