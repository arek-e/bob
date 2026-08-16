import { spawnSync } from "node:child_process"

import { discoverEnvironmentSchemaDirectories } from "./environment-schema-inventory.mjs"

const paths = discoverEnvironmentSchemaDirectories()

for (const path of paths) {
  const parts = path.split("/")
  const nestedWorkspace =
    (parts[0] === "apps" || parts[0] === "packages" || parts[0] === "tools") && parts.length > 2
  const workingDirectory = nestedWorkspace ? parts.slice(0, 2).join("/") : path
  const schemaPath = nestedWorkspace ? parts.slice(2).join("/") : "."
  const result = spawnSync("pnpm", ["exec", "varlock", "audit", "--path", schemaPath, schemaPath], {
    cwd: workingDirectory,
    stdio: "inherit"
  })
  if (result.status !== 0) process.exit(result.status ?? 1)
}
