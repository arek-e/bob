import { parseProductionDataQuery } from "@bob/operations-types/production-data"

import {
  MaintenanceCliError,
  type MaintenanceCommand,
  type MaintenanceCommandContext,
  type MaintenanceCommandResult
} from "./cli.js"
import {
  DEFAULT_APPROVAL_ENVIRONMENT,
  DEFAULT_OWNER_ID_ENVIRONMENT,
  readApprovedOwner
} from "./message-access.js"
import { addQuery, parseOptions, rejectUnknown } from "./options.js"

export const READ_LATEST_MESSAGES_HELP = [
  "Usage:",
  "  pnpm maint read-latest-messages [options]",
  "",
  "Options:",
  "  --owner-id-env <name>          Owner ID environment variable.",
  "  --approval-env <name>          Content approval environment variable.",
  "  --from <iso>                   Inclusive window start.",
  "  --to <iso>                     Exclusive window end.",
  "  --limit <1-100>                Maximum returned messages.",
  "",
  "The command calls ConversationStore directly through the maintenance runtime.",
  "It requires one explicit owner and BOB_MAINTENANCE_CONTENT_APPROVAL=owner-approved.",
  "It never accepts the owner ID or approval value as command-line arguments.",
  ""
].join("\n")

export const readLatestMessagesCommand: MaintenanceCommand = {
  name: "read-latest-messages",
  description: "Read recent messages through the application ConversationStore.",
  help: READ_LATEST_MESSAGES_HELP,
  run: executeReadLatestMessages
}

export async function executeReadLatestMessages({
  argv,
  env,
  getRuntime
}: MaintenanceCommandContext): Promise<MaintenanceCommandResult> {
  const options = parseOptions(argv)
  rejectUnknown(options, ["owner-id-env", "approval-env", "from", "to", "limit"])

  const ownerIdEnvironment = options.get("owner-id-env") ?? DEFAULT_OWNER_ID_ENVIRONMENT
  const approvalEnvironment = options.get("approval-env") ?? DEFAULT_APPROVAL_ENVIRONMENT
  const ownerId = readApprovedOwner(env, ownerIdEnvironment, approvalEnvironment)

  const query = parseQuery(options)
  const conversations = await (await getRuntime()).getConversations()
  const messages = await conversations.listMessages(ownerId, query)
  return {
    output: `${JSON.stringify({ from: query.from, to: query.to, messages }, null, 2)}\n`
  }
}

function parseQuery(options: ReadonlyMap<string, string>) {
  try {
    const query = new URLSearchParams()
    addQuery(query, "from", options.get("from"))
    addQuery(query, "to", options.get("to"))
    addQuery(query, "limit", options.get("limit"))
    return parseProductionDataQuery({
      from: query.get("from"),
      to: query.get("to"),
      limit: query.get("limit")
    })
  } catch {
    throw new MaintenanceCliError("Message query is invalid")
  }
}
