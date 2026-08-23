import {
  MaintenanceCliError,
  type MaintenanceCommand,
  type MaintenanceCommandContext,
  type MaintenanceCommandResult
} from "./cli.js"
import {
  addQuery,
  buildUrl,
  ENVIRONMENT_NAME,
  parseOptions,
  rejectUnknown,
  requiredOption,
  withQuery
} from "./options.js"

const DEFAULT_SESSION_COOKIE_ENVIRONMENT = "BOB_OWNER_SESSION_COOKIE"
const REQUEST_TIMEOUT_MS = 15_000

export const READ_LATEST_MESSAGES_HELP = [
  "Usage:",
  "  pnpm maint read-latest-messages [options]",
  "",
  "Options:",
  "  --base-url <url>                 Private Core URL, or BOB_PRODUCTION_CORE_URL.",
  "  --session-cookie-env <name>      Owner session cookie environment variable.",
  "  --from <iso>                     Inclusive window start.",
  "  --to <iso>                       Exclusive window end.",
  "  --limit <1-100>                  Maximum returned messages.",
  "",
  "The command requires a Better Auth owner session cookie. It never accepts the cookie as an argument.",
  ""
].join("\n")

export const readLatestMessagesCommand: MaintenanceCommand = {
  name: "read-latest-messages",
  description: "Read recent message content through the owner session boundary.",
  help: READ_LATEST_MESSAGES_HELP,
  run: executeReadLatestMessages
}

export async function executeReadLatestMessages({
  argv,
  env,
  fetchImplementation
}: MaintenanceCommandContext): Promise<MaintenanceCommandResult> {
  const options = parseOptions(argv)
  rejectUnknown(options, ["base-url", "session-cookie-env", "from", "to", "limit"])

  const baseUrl = requiredOption(options, "base-url", env.BOB_PRODUCTION_CORE_URL)
  const sessionCookieEnvironment =
    options.get("session-cookie-env") ?? DEFAULT_SESSION_COOKIE_ENVIRONMENT
  if (!ENVIRONMENT_NAME.test(sessionCookieEnvironment)) {
    throw new MaintenanceCliError(
      "Option --session-cookie-env must be an environment variable name"
    )
  }

  const sessionCookie = env[sessionCookieEnvironment]
  if (sessionCookie === undefined || sessionCookie.length === 0) {
    throw new MaintenanceCliError("Owner session cookie is missing")
  }

  const query = new URLSearchParams()
  addQuery(query, "from", options.get("from"))
  addQuery(query, "to", options.get("to"))
  addQuery(query, "limit", options.get("limit"))
  const url = buildUrl(baseUrl, withQuery("/api/production-data/messages", query))

  let response: Response
  try {
    response = await fetchImplementation(url, {
      headers: { cookie: sessionCookie },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    })
  } catch {
    throw new MaintenanceCliError("Message request failed")
  }

  if (response.status === 401) {
    throw new MaintenanceCliError("Owner session is unauthorized")
  }
  if (!response.ok) {
    throw new MaintenanceCliError(`Message request failed with HTTP ${response.status}`)
  }

  let body: unknown
  try {
    body = await response.json()
  } catch {
    throw new MaintenanceCliError("Message response was not valid JSON")
  }
  return { output: `${JSON.stringify(body, null, 2)}\n` }
}
