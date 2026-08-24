#!/usr/bin/env node

import { spawnSync } from "node:child_process"

import { isMaintenanceDiscoveryInvocation } from "./maintenance/discovery.js"

const args = process.argv.slice(2)
const discoveryOnly = isMaintenanceDiscoveryInvocation(args)
const command = discoveryOnly
  ? ["tsx", "tools/cli.tsx", ...args]
  : [
      "varlock",
      "run",
      "--path",
      "tools",
      "--inject",
      "vars",
      "--skip-cache",
      "--",
      "tsx",
      "tools/cli.tsx",
      ...args
    ]
const executable = command[0] ?? "tsx"
const commandArgs = command.slice(1)

const result = spawnSync(executable, commandArgs, {
  env: process.env,
  stdio: "inherit"
})

if (result.error) {
  console.error("Maintenance CLI failed to start")
  process.exitCode = 1
} else if (result.signal !== null) {
  process.exitCode = 1
} else {
  process.exitCode = result.status ?? 1
}
