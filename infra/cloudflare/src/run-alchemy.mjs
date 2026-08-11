import { spawnSync } from "node:child_process"
import { resolve } from "node:path"
import { pathToFileURL } from "node:url"

const COMMANDS = new Set(["plan", "deploy"])

export function alchemyCommandArguments(command) {
  if (!COMMANDS.has(command)) throw new Error("Alchemy command must be plan or deploy")
  return ["exec", "alchemy", command, "--stage", "prod", ...(command === "deploy" ? ["--yes"] : [])]
}

function run(command) {
  const result = spawnSync("pnpm", alchemyCommandArguments(command), {
    env: process.env,
    stdio: "inherit"
  })
  if (result.error !== undefined) throw result.error
  if (result.signal !== null) throw new Error(`Alchemy was stopped by ${result.signal}`)
  process.exitCode = result.status ?? 1
}

const entry = process.argv[1]
if (entry !== undefined && pathToFileURL(resolve(entry)).href === import.meta.url) {
  run(process.argv[2])
}
