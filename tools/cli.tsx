#!/usr/bin/env node

import { render } from "ink"
import React from "react"

import { MaintenanceApp } from "./maintenance/app.js"
import { inspectWorkflowCommand, summarizeActivityCommand } from "./maintenance/production-data.js"
import { readLatestMessagesCommand } from "./maintenance/read-latest-messages.js"

const commands = [
  readLatestMessagesCommand,
  summarizeActivityCommand,
  inspectWorkflowCommand
] as const
const instance = render(
  <MaintenanceApp
    argv={process.argv.slice(2)}
    commands={commands}
    env={process.env}
    fetchImplementation={fetch}
    onComplete={(exitCode) => {
      process.exitCode = exitCode
    }}
  />
)

await instance.waitUntilExit()
