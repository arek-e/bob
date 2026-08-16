import { spawnSync } from "node:child_process"

import { discoverEnvironmentSchemaDirectories } from "./environment-schema-inventory.mjs"

const schemaArguments = discoverEnvironmentSchemaDirectories().flatMap((path) => ["--path", path])
const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm"
const result = spawnSync(pnpm, ["exec", "varlock", "scan", "--staged", ...schemaArguments], {
  stdio: "inherit"
})

if (result.error !== undefined) throw result.error
if (result.signal !== null) throw new Error(`Secret scan stopped with ${result.signal}`)
process.exitCode = result.status ?? 1
