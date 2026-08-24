import { CONVERSATION_MESSAGE_MAX_LIMIT } from "@bob/conversations-types/store"
import { PRODUCTION_DATA_MAX_WINDOW_MS } from "@bob/operations-types/production-data"

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
import { parseOptions, rejectUnknown, requiredOption } from "./options.js"

export const READ_ALL_MESSAGES_HELP = [
  "Usage:",
  "  pnpm maint read-all-messages --from <iso> --to <iso> [options]",
  "",
  "Options:",
  "  --owner-id-env <name>       Owner ID environment variable.",
  "  --approval-env <name>       Content approval environment variable.",
  "  --from <iso>                Inclusive UTC window start (required).",
  "  --to <iso>                  Exclusive UTC window end (required).",
  `  --limit <1-${CONVERSATION_MESSAGE_MAX_LIMIT}>          Hard message cap.`,
  "",
  "The command reads all messages for one explicit owner in the bounded window.",
  `The window is limited to 31 days and the result is capped at ${CONVERSATION_MESSAGE_MAX_LIMIT} messages.`,
  "It requires BOB_MAINTENANCE_CONTENT_APPROVAL=owner-approved.",
  "It never accepts the owner ID or approval value as command-line arguments.",
  ""
].join("\n")

export const readAllMessagesCommand: MaintenanceCommand = {
  name: "read-all-messages",
  description: "Read all bounded messages for one owner.",
  help: READ_ALL_MESSAGES_HELP,
  run: executeReadAllMessages
}

export async function executeReadAllMessages({
  argv,
  env,
  getRuntime
}: MaintenanceCommandContext): Promise<MaintenanceCommandResult> {
  const options = parseOptions(argv)
  rejectUnknown(options, ["owner-id-env", "approval-env", "from", "to", "limit"])

  const ownerIdEnvironment = options.get("owner-id-env") ?? DEFAULT_OWNER_ID_ENVIRONMENT
  const approvalEnvironment = options.get("approval-env") ?? DEFAULT_APPROVAL_ENVIRONMENT
  const ownerId = readApprovedOwner(env, ownerIdEnvironment, approvalEnvironment)

  const query = parseAllMessagesQuery(options)
  const conversations = await (await getRuntime()).getConversations()
  const messages = await conversations.listMessages(ownerId, query)
  return {
    output: `${JSON.stringify(
      {
        from: query.from,
        to: query.to,
        messageCount: messages.length,
        possiblyMore: messages.length === query.limit,
        messages
      },
      null,
      2
    )}\n`
  }
}

function parseAllMessagesQuery(options: ReadonlyMap<string, string>) {
  const fromValue = requiredOption(options, "from")
  const toValue = requiredOption(options, "to")
  const from = new Date(fromValue)
  const to = new Date(toValue)
  const limitValue = options.get("limit") ?? String(CONVERSATION_MESSAGE_MAX_LIMIT)
  if (
    Number.isNaN(from.getTime()) ||
    Number.isNaN(to.getTime()) ||
    from >= to ||
    to.getTime() - from.getTime() > PRODUCTION_DATA_MAX_WINDOW_MS ||
    !/^\d+$/u.test(limitValue)
  ) {
    throw new MaintenanceCliError("All-message query is invalid")
  }
  const limit = Number(limitValue)
  if (limit < 1 || limit > CONVERSATION_MESSAGE_MAX_LIMIT) {
    throw new MaintenanceCliError("All-message query is invalid")
  }
  return { from: from.toISOString(), to: to.toISOString(), limit }
}
