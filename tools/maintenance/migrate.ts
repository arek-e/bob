import {
  type MaintenanceCommand,
  type MaintenanceCommandContext,
  type MaintenanceCommandResult
} from "./cli.js"
import { parseOptions, rejectUnknown } from "./options.js"

export const MIGRATE_HELP = [
  "Usage:",
  "  pnpm maint migrate",
  "",
  "Runs the shared PostgreSQL migration program through the Database Module.",
  "",
  "DATABASE_URL is read from the environment. Migration files default to",
  "packages/db/service/migrations or BOB_MIGRATIONS_FOLDER.",
  ""
].join("\n")

export const migrateCommand: MaintenanceCommand = {
  name: "migrate",
  description: "Run the shared PostgreSQL migration program.",
  help: MIGRATE_HELP,
  run: executeMigrate
}

export async function executeMigrate({
  argv,
  getRuntime
}: MaintenanceCommandContext): Promise<MaintenanceCommandResult> {
  const options = parseOptions(argv)
  rejectUnknown(options, [])
  await (await getRuntime()).migrate()
  return { output: '{"operation":"migrate","status":"completed"}\n' }
}
