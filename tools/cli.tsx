#!/usr/bin/env node

import { render } from "ink"
import React from "react"

import { MaintenanceApp } from "./maintenance/app.js"
import { migrateCommand } from "./maintenance/migrate.js"
import { inspectWorkflowCommand, summarizeActivityCommand } from "./maintenance/production-data.js"
import { readAllMessagesCommand } from "./maintenance/read-all-messages.js"
import { readLatestMessagesCommand } from "./maintenance/read-latest-messages.js"
import { createMaintenanceRuntime } from "./maintenance/runtime.js"
import { showContextCommand } from "./maintenance/show-context.js"

const localCommands = [
  showContextCommand,
  migrateCommand,
  readAllMessagesCommand,
  readLatestMessagesCommand,
  summarizeActivityCommand,
  inspectWorkflowCommand
] as const
const instance = render(
  <MaintenanceApp
    argv={process.argv.slice(2)}
    commands={localCommands}
    env={process.env}
    createRuntime={(env, executionContext) => createMaintenanceRuntime({ env, executionContext })}
    onComplete={(exitCode) => {
      process.exitCode = exitCode
    }}
  />
)

await instance.waitUntilExit()
