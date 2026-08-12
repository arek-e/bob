import { spawnSync } from "node:child_process"
import { readdir } from "node:fs/promises"
import { join } from "node:path"

const schemaPaths = [
  "apps/core-worker",
  "apps/sendblue-ingress",
  "apps/sendblue-egress",
  "apps/agent",
  "tools/sendblue-reconcile",
  "tools/pi-smoke",
  "tools/data-backup",
  "infra/cloudflare"
]

const artifactPaths = [
  "apps/agent/dist",
  "apps/core-worker/dist",
  "apps/sendblue-egress/dist",
  "apps/sendblue-ingress/dist",
  "apps/ui/dist",
  "tools/data-backup/dist"
]

function trackedFiles() {
  const result = spawnSync("git", ["ls-files", "-z"], { encoding: "utf8" })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) throw new Error("git ls-files failed")
  return result.stdout.split("\0").filter((path) => path.length > 0)
}

async function filesIn(directory) {
  let entries
  try {
    entries = await readdir(directory, { withFileTypes: true })
  } catch (error) {
    if (error !== null && typeof error === "object" && error.code === "ENOENT") return []
    throw error
  }

  const files = []
  for (const entry of entries) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) files.push(...(await filesIn(path)))
    else if (entry.isFile()) files.push(path)
  }
  return files
}

const artifacts = (await Promise.all(artifactPaths.map(filesIn))).flat()
const targets = [...new Set([...trackedFiles(), ...artifacts])]
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
