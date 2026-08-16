import { spawnSync } from "node:child_process"
import { readdir } from "node:fs/promises"
import { join } from "node:path"

import { environmentSchemaDirectories, readTrackedFiles } from "./environment-schema-inventory.mjs"

const artifactPaths = [
  "apps/agent/dist",
  "apps/connections-gateway/dist",
  "apps/core-worker/dist",
  "apps/eval-worker/dist",
  "apps/managed-channel-router/dist",
  "apps/sendblue-egress/dist",
  "apps/sendblue-ingress/dist",
  "apps/ui/dist",
  "tools/data-backup/dist"
]

async function filesIn(directory) {
  let entries
  try {
    entries = await readdir(directory, { withFileTypes: true })
  } catch (cause) {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") return []
    throw cause
  }

  const files = []
  for (const entry of entries) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) files.push(...(await filesIn(path)))
    else if (entry.isFile()) files.push(path)
  }
  return files
}

const trackedFiles = readTrackedFiles()
const schemaPaths = environmentSchemaDirectories(trackedFiles)
const artifacts = (await Promise.all(artifactPaths.map(filesIn))).flat()
const targets = [...new Set([...trackedFiles, ...artifacts])]
  .map((path) => (path.startsWith("./") ? path : `./${path}`))
  .sort()
const schemaArguments = schemaPaths.flatMap((path) => ["--path", path])
const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm"

if (targets.length === 0) throw new Error("Trusted secret scan has no targets")
console.log(`Scanning ${targets.length} tracked and generated files.`)

const result = spawnSync(pnpm, ["exec", "varlock", "scan", ...schemaArguments, "--", ...targets], {
  stdio: "inherit"
})

if (result.error !== undefined) throw result.error
if (result.signal !== null) throw new Error(`Secret scan stopped with ${result.signal}`)
process.exitCode = result.status ?? 1
