export type MaintenanceCommandContext = {
  readonly argv: readonly string[]
  readonly env: NodeJS.ProcessEnv
  readonly fetchImplementation: typeof fetch
}

export type MaintenanceCommandResult = {
  readonly output: string
}

export type MaintenanceCommand = {
  readonly name: string
  readonly description: string
  readonly help: string
  readonly run: (
    context: MaintenanceCommandContext
  ) => Promise<MaintenanceCommandResult> | MaintenanceCommandResult
}

export type MaintenanceExecution =
  | {
      readonly status: "success"
      readonly output: string
      readonly exitCode: 0
    }
  | {
      readonly status: "failure"
      readonly error: string
      readonly exitCode: 1
    }

export class MaintenanceCliError extends Error {}

export async function runMaintenanceCli({
  argv,
  commands,
  env,
  fetchImplementation = fetch
}: {
  readonly argv: readonly string[]
  readonly commands: readonly MaintenanceCommand[]
  readonly env: NodeJS.ProcessEnv
  readonly fetchImplementation?: typeof fetch
}): Promise<MaintenanceExecution> {
  const [commandName, ...commandArguments] = argv

  if (
    commandName === undefined ||
    commandName === "help" ||
    commandName === "--help" ||
    commandName === "-h"
  ) {
    return success(renderHelp(commands))
  }

  const command = commands.find((candidate) => candidate.name === commandName)
  if (command === undefined) {
    return failure(`Unknown maintenance command: ${commandName}\n${renderHelp(commands).trimEnd()}`)
  }

  if (commandArguments.includes("--help") || commandArguments.includes("-h")) {
    return success(command.help)
  }

  try {
    const result = await command.run({
      argv: commandArguments,
      env,
      fetchImplementation
    })
    return success(result.output)
  } catch (error) {
    if (error instanceof MaintenanceCliError) return failure(error.message)
    return failure("Maintenance command failed")
  }
}

function success(output: string): MaintenanceExecution {
  return { status: "success", output, exitCode: 0 }
}

function failure(error: string): MaintenanceExecution {
  return { status: "failure", error, exitCode: 1 }
}

function renderHelp(commands: readonly MaintenanceCommand[]): string {
  const commandLines = commands.map(
    ({ name, description }) => `  ${name.padEnd(18)} ${description}`
  )
  return [
    "Usage: pnpm maint <command> [options]",
    "",
    "Commands:",
    ...commandLines,
    "",
    "Use `pnpm maint <command> --help` for command details.",
    ""
  ].join("\n")
}
