import { spawnSync } from "node:child_process"

import { isMaintenanceDiscoveryInvocation } from "../../../tools/maintenance/discovery.js"

const args = process.argv.slice(2)
const discoveryOnly = isMaintenanceDiscoveryInvocation(args)
const maintenanceCli = ["node", "/app/dist/maintenance.mjs", ...args]
const command = discoveryOnly
  ? maintenanceCli
  : [
      "node",
      "/app/node_modules/varlock/bin/cli.js",
      "run",
      "--path",
      "/app/tools",
      "--inject",
      "vars",
      "--skip-cache",
      "--",
      ...maintenanceCli
    ]
const executable = command[0] ?? "node"
const commandArgs = command.slice(1)

const result = spawnSync(executable, commandArgs, {
  env: process.env,
  stdio: "inherit"
})

if (result.error) {
  console.error("Maintenance command failed to start")
  process.exitCode = 1
} else if (result.signal !== null) {
  process.exitCode = 1
} else {
  process.exitCode = result.status ?? 1
}
