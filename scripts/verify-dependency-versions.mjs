import { readdir, readFile } from "node:fs/promises"
import { join } from "node:path"

const roots = ["apps", "packages", "tools"]
const manifests = ["package.json", "infra/cloudflare/package.json"]
for (const root of roots) {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.isDirectory()) manifests.push(join(root, entry.name, "package.json"))
  }
}

const exactVersion = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u
const failures = []
for (const manifest of manifests) {
  const value = JSON.parse(await readFile(manifest, "utf8"))
  const dependencies = {
    ...value.dependencies,
    ...value.devDependencies,
    ...value.optionalDependencies
  }
  for (const [name, version] of Object.entries(dependencies)) {
    if (version !== "workspace:*" && !exactVersion.test(version)) {
      failures.push(`${manifest}: ${name} must use one exact version, not ${version}`)
    }
    const isEffect = name === "effect" || name.startsWith("@effect/")
    if (isEffect) {
      const expected =
        manifest === "infra/cloudflare/package.json" ? "4.0.0-beta.102" : "4.0.0-beta.107"
      if (version !== expected) failures.push(`${manifest}: ${name} must use ${expected}`)
    }
    if ((name === "drizzle-orm" || name === "drizzle-kit") && version !== "1.0.0-rc.4") {
      failures.push(`${manifest}: ${name} must use 1.0.0-rc.4`)
    }
  }
}

if (failures.length > 0) {
  console.error(failures.join("\n"))
  process.exitCode = 1
} else {
  console.log(`Verified exact dependency policy in ${manifests.length} workspaces.`)
}
