import { Box, Text, useApp } from "ink"
import React, { useEffect, useState } from "react"

import type { MaintenanceExecutionContext } from "./context.js"
import type { MaintenanceRuntime } from "./runtime.js"

import { runMaintenanceCli, type MaintenanceCommand, type MaintenanceExecution } from "./cli.js"

export function MaintenanceApp({
  argv,
  commands,
  env,
  createRuntime,
  onComplete
}: {
  readonly argv: readonly string[]
  readonly commands: readonly MaintenanceCommand[]
  readonly env: NodeJS.ProcessEnv
  readonly createRuntime: (
    env: NodeJS.ProcessEnv,
    executionContext: MaintenanceExecutionContext
  ) => Promise<MaintenanceRuntime>
  readonly onComplete: (exitCode: 0 | 1) => void
}) {
  const [execution, setExecution] = useState<MaintenanceExecution>()
  const { exit, waitUntilRenderFlush } = useApp()

  useEffect(() => {
    let active = true

    void runMaintenanceCli({ argv, commands, env, createRuntime }).then((result) => {
      if (!active) return
      setExecution(result)
      onComplete(result.exitCode)
    })

    return () => {
      active = false
    }
  }, [argv, commands, env, createRuntime, onComplete])

  useEffect(() => {
    if (execution === undefined) return
    let active = true

    void waitUntilRenderFlush().then(() => {
      if (!active) return
      exit()
    })

    return () => {
      active = false
    }
  }, [execution, exit, waitUntilRenderFlush])

  if (execution === undefined) {
    return <Text color="cyan">Running: {formatCommand(argv)}</Text>
  }

  if (execution.status === "failure") {
    return (
      <Box>
        <Text color="red">Error: {execution.error}</Text>
      </Box>
    )
  }

  return <Text>{execution.output.length === 0 ? "Done." : execution.output}</Text>
}

function formatCommand(argv: readonly string[]): string {
  return argv.length === 0 ? "help" : argv.join(" ")
}
