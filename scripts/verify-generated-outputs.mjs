import { Generator, getConfig } from "@tanstack/router-generator"
import { spawnSync } from "node:child_process"
import { mkdtemp, mkdir, readFile, rm, cp, copyFile } from "node:fs/promises"
import { dirname, isAbsolute, join, posix, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { discoverEnvironmentSchemaDirectories } from "./environment-schema-inventory.mjs"

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const environmentTypeDirective = /@generateTsTypes\(path=([^,\s)]+)/u

function checkedOutputPath(schemaDirectory, configuredPath) {
  const normalized = posix.normalize(configuredPath.replace(/^\.\//u, ""))
  if (isAbsolute(configuredPath) || normalized === ".." || normalized.startsWith("../")) {
    throw new Error(`Generated environment output must stay in ${schemaDirectory}`)
  }
  return posix.join(schemaDirectory, normalized)
}

export async function declaredEnvironmentOutputs({ root = repositoryRoot, directories } = {}) {
  const schemaDirectories = directories ?? discoverEnvironmentSchemaDirectories({ cwd: root })
  const outputs = []

  for (const directory of schemaDirectories) {
    const schema = await readFile(join(root, directory, ".env.schema"), "utf8")
    const match = environmentTypeDirective.exec(schema)
    if (match === null) continue
    outputs.push({
      directory,
      output: checkedOutputPath(directory, match[1])
    })
  }

  return outputs
}

export async function assertGeneratedFilesMatch(outputs) {
  const stale = []
  for (const output of outputs) {
    const [checkedIn, generated] = await Promise.all([
      readFile(output.checkedIn),
      readFile(output.generated)
    ])
    if (!checkedIn.equals(generated)) stale.push(output.label)
  }

  if (stale.length > 0) {
    throw new Error(`Generated outputs are stale:\n${stale.map((path) => `- ${path}`).join("\n")}`)
  }
}

function runVarlockCodegen(schemaDirectory) {
  const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm"
  const result = spawnSync(pnpm, ["exec", "varlock", "codegen", "--path", schemaDirectory], {
    cwd: repositoryRoot,
    encoding: "utf8"
  })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) {
    throw new Error(
      result.stderr || result.stdout || `Varlock code generation failed for ${schemaDirectory}`
    )
  }
}

async function generateEnvironmentTypes(temporaryRoot, outputs) {
  await copyFile(join(repositoryRoot, ".env.schema"), join(temporaryRoot, ".env.schema"))

  for (const output of outputs) {
    const temporaryDirectory = join(temporaryRoot, output.directory)
    await mkdir(dirname(join(temporaryRoot, output.output)), { recursive: true })
    await copyFile(
      join(repositoryRoot, output.directory, ".env.schema"),
      join(temporaryDirectory, ".env.schema")
    )
    runVarlockCodegen(temporaryDirectory)
  }
}

async function generateRouteTree(temporaryRoot) {
  const uiRoot = join(temporaryRoot, "apps/ui")
  await mkdir(join(uiRoot, "src"), { recursive: true })
  await cp(join(repositoryRoot, "apps/ui/src/routes"), join(uiRoot, "src/routes"), {
    recursive: true
  })

  const config = getConfig(
    {
      target: "solid",
      routesDirectory: "./src/routes",
      generatedRouteTree: "./src/routeTree.gen.ts",
      disableLogging: true,
      autoCodeSplitting: true,
      routeTreeFileFooter: [
        `import type { getRouter } from './router.tsx'
import type { createStart } from '@tanstack/solid-start'
declare module '@tanstack/solid-start' {
  interface Register {
    ssr: true
    router: Awaited<ReturnType<typeof getRouter>>
  }
}`
      ]
    },
    uiRoot
  )
  await new Generator({ config, root: uiRoot }).run()
}

export async function verifyGeneratedOutputs() {
  const temporaryParent = join(repositoryRoot, "node_modules/.cache")
  await mkdir(temporaryParent, { recursive: true })
  const temporaryRoot = await mkdtemp(join(temporaryParent, "bob-generated-check-"))
  try {
    const environmentOutputs = await declaredEnvironmentOutputs()
    await generateEnvironmentTypes(temporaryRoot, environmentOutputs)
    await generateRouteTree(temporaryRoot)

    await assertGeneratedFilesMatch([
      ...environmentOutputs.map((output) => ({
        label: output.output,
        checkedIn: join(repositoryRoot, output.output),
        generated: join(temporaryRoot, output.output)
      })),
      {
        label: "apps/ui/src/routeTree.gen.ts",
        checkedIn: join(repositoryRoot, "apps/ui/src/routeTree.gen.ts"),
        generated: join(temporaryRoot, "apps/ui/src/routeTree.gen.ts")
      }
    ])
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true })
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await verifyGeneratedOutputs()
  console.log("Checked-in generated outputs are current.")
}
