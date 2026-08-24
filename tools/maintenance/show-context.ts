import type {
  MaintenanceCommand,
  MaintenanceCommandContext,
  MaintenanceCommandResult
} from "./cli.js"

export const SHOW_CONTEXT_HELP = [
  "Usage:",
  "  pnpm maint context",
  "",
  "Prints the explicit environment, Runtime Target, release, and job context.",
  "This command does not open PostgreSQL or resolve database secrets.",
  ""
].join("\n")

export const showContextCommand: MaintenanceCommand = {
  name: "context",
  description: "Show the Runtime Target and maintenance job context.",
  help: SHOW_CONTEXT_HELP,
  run: executeShowContext
}

export function executeShowContext({
  executionContext
}: MaintenanceCommandContext): MaintenanceCommandResult {
  return {
    output: `${JSON.stringify({ executionContext }, null, 2)}\n`
  }
}
