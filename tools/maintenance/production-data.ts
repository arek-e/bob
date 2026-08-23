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

const DEFAULT_TOKEN_ENVIRONMENT = "PRODUCTION_DATA_INSPECTOR_TOKEN"
const REQUEST_TIMEOUT_MS = 15_000

export const SUMMARIZE_ACTIVITY_HELP = [
  "Usage:",
  "  pnpm maint summarize-activity [options]",
  "",
  "Options:",
  "  --base-url <url>           Private Core URL, or BOB_PRODUCTION_CORE_URL.",
  "  --token-env <name>         Token environment variable name.",
  "  --from <iso>               Inclusive summary window start.",
  "  --to <iso>                 Exclusive summary window end.",
  "  --limit <1-100>            Maximum returned rows or grouped records.",
  "",
  "The caller token is read from the environment and is never accepted as an argument.",
  ""
].join("\n")

export const INSPECT_WORKFLOW_HELP = [
  "Usage:",
  "  pnpm maint inspect-workflow --correlation-id <value> [options]",
  "",
  "Options:",
  "  --base-url <url>           Private Core URL, or BOB_PRODUCTION_CORE_URL.",
  "  --token-env <name>         Token environment variable name.",
  "  --correlation-id <value>   Workflow correlation ID.",
  "  --limit <1-100>            Maximum returned records per group.",
  "",
  "The caller token is read from the environment and is never accepted as an argument.",
  ""
].join("\n")

export const summarizeActivityCommand: MaintenanceCommand = {
  name: "summarize-activity",
  description: "Summarize bounded production message and Agent activity.",
  help: SUMMARIZE_ACTIVITY_HELP,
  run: (context) => executeProductionData({ ...context, argv: ["summary", ...context.argv] })
}

export const inspectWorkflowCommand: MaintenanceCommand = {
  name: "inspect-workflow",
  description: "Inspect one bounded workflow by correlation ID.",
  help: INSPECT_WORKFLOW_HELP,
  run: (context) => executeProductionData({ ...context, argv: ["workflow", ...context.argv] })
}

export async function executeProductionData({
  argv,
  env,
  fetchImplementation
}: MaintenanceCommandContext): Promise<MaintenanceCommandResult> {
  const [operation, ...arguments_] = argv
  if (
    operation === undefined ||
    operation === "help" ||
    operation === "--help" ||
    operation === "-h" ||
    arguments_.includes("--help") ||
    arguments_.includes("-h")
  ) {
    return { output: SUMMARIZE_ACTIVITY_HELP }
  }

  const options = parseOptions(arguments_)
  const baseUrl = requiredOption(options, "base-url", env.BOB_PRODUCTION_CORE_URL)
  const tokenEnvironment = options.get("token-env") ?? DEFAULT_TOKEN_ENVIRONMENT
  if (!ENVIRONMENT_NAME.test(tokenEnvironment)) {
    throw new MaintenanceCliError("Option --token-env must be an environment variable name")
  }

  const token = env[tokenEnvironment]
  if (token === undefined || token.length < 32) {
    throw new MaintenanceCliError("Inspector token is missing or invalid")
  }

  const endpoint =
    operation === "summary" ? summaryEndpoint(options) : workflowEndpoint(operation, options)
  const url = buildUrl(baseUrl, endpoint)

  let response: Response
  try {
    response = await fetchImplementation(url, {
      headers: { "x-bob-caller-token": token },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    })
  } catch {
    throw new MaintenanceCliError("Inspector request failed")
  }

  if (!response.ok) throw inspectorResponseError(response.status)

  let body: unknown
  try {
    body = await response.json()
  } catch {
    throw new MaintenanceCliError("Inspector response was not valid JSON")
  }
  return { output: `${JSON.stringify(body, null, 2)}\n` }
}

function inspectorResponseError(status: number): MaintenanceCliError {
  if (status === 401) {
    return new MaintenanceCliError(
      "Inspector authentication failed (HTTP 401); verify the configured inspector token and Core secret projection"
    )
  }
  if (status === 404) {
    return new MaintenanceCliError(
      "Inspector endpoint is not deployed (HTTP 404); promote a Runtime release that includes production-data inspection"
    )
  }
  return new MaintenanceCliError(`Inspector request failed with HTTP ${status}`)
}

function summaryEndpoint(options: ReadonlyMap<string, string>): string {
  rejectUnknown(options, ["base-url", "token-env", "from", "to", "limit"])
  const query = new URLSearchParams()
  addQuery(query, "from", options.get("from"))
  addQuery(query, "to", options.get("to"))
  addQuery(query, "limit", options.get("limit"))
  return withQuery("/internal/production-data/summary", query)
}

function workflowEndpoint(operation: string, options: ReadonlyMap<string, string>): string {
  if (operation !== "workflow") {
    throw new MaintenanceCliError(`Unknown production-data command: ${operation}`)
  }
  rejectUnknown(options, ["base-url", "token-env", "correlation-id", "limit"])
  const correlationId = requiredOption(options, "correlation-id")
  const query = new URLSearchParams()
  addQuery(query, "limit", options.get("limit"))
  return withQuery(`/internal/production-data/workflow/${encodeURIComponent(correlationId)}`, query)
}
