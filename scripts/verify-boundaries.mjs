import { readFile, readdir } from "node:fs/promises"
import { extname, join, sep } from "node:path"

const root = new URL("../", import.meta.url)
const sourceRoots = ["apps", "packages", "tools", "infra/cloudflare"]
const sourceExtensions = new Set([".ts", ".tsx", ".mts", ".js", ".mjs"])
const importPattern = /(?:from\s+|import\s*\()["']([^"']+)["']/g

const violations = []
const generalCoreFiles = new Set([
  "apps/core-worker/src/core-composition.ts",
  "apps/core-worker/src/process-inbound.ts",
  "apps/core-worker/src/entrypoints/http.ts",
  "apps/core-worker/src/entrypoints/scheduled.ts",
  "apps/core-worker/src/entrypoints/durable-objects.ts",
  "packages/contracts/src/deployment-profiles/core.ts"
])

function isGeneralCoreFile(file) {
  return (
    generalCoreFiles.has(file) ||
    file.startsWith("apps/core-worker/src/modules/policy/") ||
    file.startsWith("apps/core-worker/src/modules/delivery/")
  )
}

async function walk(directory) {
  const entries = await readdir(new URL(`${directory}/`, root), { withFileTypes: true })
  const files = []
  for (const entry of entries) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) files.push(...(await walk(path)))
    else if (sourceExtensions.has(extname(entry.name))) files.push(path)
  }
  return files
}

function topWorkspace(path) {
  const parts = path.split(sep)
  if (parts[0] === "infra") return parts.slice(0, 2).join("/")
  return parts.slice(0, 2).join("/")
}

for (const sourceRoot of sourceRoots) {
  let files = []
  try {
    files = await walk(sourceRoot)
  } catch (error) {
    if (error?.code === "ENOENT") continue
    throw error
  }

  for (const file of files) {
    const text = await readFile(new URL(file, root), "utf8")
    for (const match of text.matchAll(importPattern)) {
      const specifier = match[1]
      const workspace = topWorkspace(file)

      if (
        isGeneralCoreFile(file) &&
        (specifier.match(/modules\/(?:reminders|journal|training|connections)\//) !== null ||
          specifier.match(
            /@bob\/contracts\/(?:capabilities\/(?:reminders|journal|training|connections)|deployment-profiles\/transitional)/
          ) !== null)
      ) {
        violations.push(`${file}: General Core cannot import a Vertical Module`)
      }

      if (workspace.startsWith("packages/") && specifier.startsWith("@bob/") === false) {
        if (specifier.includes("/apps/")) violations.push(`${file}: packages cannot import apps`)
      }

      if (workspace !== "packages/pi-agent" && specifier.startsWith("@earendil-works/pi-")) {
        violations.push(`${file}: only @bob/pi-agent can import Pi`)
      }

      const sendblueConsumer =
        workspace === "apps/sendblue-ingress" ||
        workspace === "apps/sendblue-egress" ||
        workspace === "apps/managed-channel-router" ||
        workspace === "tools/sendblue-reconcile"
      if (!sendblueConsumer && specifier.startsWith("@bob/sendblue")) {
        violations.push(`${file}: this workspace cannot import @bob/sendblue`)
      }

      if (workspace.startsWith("apps/") && specifier.includes("../apps/")) {
        violations.push(`${file}: apps cannot import another app source`)
      }

      if (workspace !== "apps/core-worker" && specifier === "drizzle-orm/d1") {
        violations.push(`${file}: only the core Worker can import the D1 adapter`)
      }

      if (workspace.startsWith("apps/") && workspace !== "apps/agent") {
        if (specifier.startsWith("@effect/platform-node")) {
          violations.push(`${file}: Worker and browser apps cannot import Node platform code`)
        }
      }

      if (specifier.startsWith("effect/unstable/")) {
        violations.push(`${file}: unstable Effect modules are not allowed`)
      }
    }
  }
}

if (violations.length > 0) {
  console.error(violations.join("\n"))
  process.exitCode = 1
} else {
  console.log("Repository dependency boundaries are valid.")
}
