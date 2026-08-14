import { spawnSync } from "node:child_process"
import { resolve } from "node:path"
import { pathToFileURL } from "node:url"

const COMMANDS = new Set(["plan"])
const MAIN_FILES = new Set(["alchemy.run.ts", "alchemy.evals.run.ts"])

export function alchemyCommandArguments(command, main) {
  if (!COMMANDS.has(command)) throw new Error("Alchemy command must be plan")
  if (main !== undefined && !MAIN_FILES.has(main))
    throw new Error("Alchemy main file is not allowed")
  return ["exec", "alchemy", command, ...(main === undefined ? [] : [main]), "--stage", "prod"]
}

function run(command, main) {
  const result = spawnSync("pnpm", alchemyCommandArguments(command, main), {
    env: process.env,
    stdio: "inherit"
  })
  if (result.error !== undefined) throw result.error
  if (result.signal !== null) throw new Error(`Alchemy was stopped by ${result.signal}`)
  process.exitCode = result.status ?? 1
}

const entry = process.argv[1]
if (entry !== undefined && pathToFileURL(resolve(entry)).href === import.meta.url) {
  run(process.argv[2], process.argv[3])
}
