import { readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const applicationRoot = fileURLToPath(new URL("../../../application/", import.meta.url))
const generalCoreModules = [
  "artifacts",
  "context",
  "conversations",
  "delivery",
  "memory",
  "operations",
  "policy",
  "retrieval",
  "settings",
  "skills"
] as const
const verticalImplementations = new Set([
  "@bob/connections-service",
  "@bob/journal-service",
  "@bob/reminders-service",
  "@bob/training-service"
])

interface PackageManifest {
  readonly dependencies?: Readonly<Record<string, string>>
  readonly devDependencies?: Readonly<Record<string, string>>
}

function manifestFor(module: string, project: "types" | "service"): PackageManifest {
  return JSON.parse(
    readFileSync(join(applicationRoot, module, project, "package.json"), "utf8")
  ) as PackageManifest
}

describe("Application Module package graph", () => {
  it("prevents General Agent Core Modules from importing Vertical Implementations", () => {
    for (const module of generalCoreModules) {
      for (const project of ["types", "service"] as const) {
        const manifest = manifestFor(module, project)
        const dependencies = Object.keys({
          ...manifest.dependencies,
          ...manifest.devDependencies
        })
        expect(
          dependencies.filter((dependency) => verticalImplementations.has(dependency)),
          `${module}/${project} imports a Vertical Implementation`
        ).toEqual([])
      }
    }
  })
})
