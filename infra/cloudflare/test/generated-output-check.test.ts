import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

import {
  assertGeneratedFilesMatch,
  declaredEnvironmentOutputs
} from "../../../scripts/verify-generated-outputs.mjs"

describe("generated output verification", () => {
  it("discovers declared environment outputs", async () => {
    const root = await mkdtemp(join(tmpdir(), "bob-generated-discovery-test-"))
    await mkdir(join(root, "apps/example/src"), { recursive: true })
    await writeFile(
      join(root, "apps/example/.env.schema"),
      "# @generateTsTypes(path=./src/environment.generated.ts, exposeEnv=local)\n# ---\n"
    )

    await expect(
      declaredEnvironmentOutputs({ root, directories: ["apps/example"] })
    ).resolves.toEqual([
      {
        directory: "apps/example",
        output: "apps/example/src/environment.generated.ts"
      }
    ])
  })

  it("rejects a stale environment output", async () => {
    const root = await mkdtemp(join(tmpdir(), "bob-generated-env-test-"))
    const checkedIn = join(root, "environment.generated.ts")
    const generated = join(root, "fresh-environment.generated.ts")
    await writeFile(checkedIn, "old environment type\n")
    await writeFile(generated, "new environment type\n")

    await expect(
      assertGeneratedFilesMatch([
        { label: "apps/example/src/environment.generated.ts", checkedIn, generated }
      ])
    ).rejects.toThrow("apps/example/src/environment.generated.ts")
    await expect(readFile(checkedIn, "utf8")).resolves.toBe("old environment type\n")
  })

  it("rejects a stale route tree", async () => {
    const root = await mkdtemp(join(tmpdir(), "bob-generated-route-test-"))
    const checkedIn = join(root, "routeTree.gen.ts")
    const generated = join(root, "fresh-routeTree.gen.ts")
    await writeFile(checkedIn, "export const routes = ['old']\n")
    await writeFile(generated, "export const routes = ['new']\n")

    await expect(
      assertGeneratedFilesMatch([{ label: "apps/ui/src/routeTree.gen.ts", checkedIn, generated }])
    ).rejects.toThrow("apps/ui/src/routeTree.gen.ts")
    await expect(readFile(checkedIn, "utf8")).resolves.toBe("export const routes = ['old']\n")
  })
})
