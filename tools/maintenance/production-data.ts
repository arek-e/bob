import { parseProductionDataQuery } from "@bob/operations-types/production-data"

import {
  MaintenanceCliError,
  type MaintenanceCommand,
  type MaintenanceCommandContext,
  type MaintenanceCommandResult
} from "./cli.js"
import { addQuery, parseOptions, rejectUnknown, requiredOption } from "./options.js"

export const SUMMARIZE_ACTIVITY_HELP = [
  "Usage:",
  "  pnpm maint summarize-activity [options]",
  "",
  "Options:",
  "  --from <iso>       Inclusive summary window start.",
  "  --to <iso>         Exclusive summary window end.",
  "  --limit <1-100>    Maximum returned rows or grouped records.",
  "",
  "The command runs the Operations Module against PostgreSQL through the",
  "maintenance runtime. It does not call a Core HTTP route.",
  ""
].join("\n")

export const INSPECT_WORKFLOW_HELP = [
  "Usage:",
  "  pnpm maint inspect-workflow --correlation-id <value> [options]",
  "",
  "Options:",
  "  --correlation-id <value>   Workflow correlation ID.",
  "  --limit <1-100>            Maximum returned records per group.",
  "",
  "The command runs the Operations Module against PostgreSQL through the",
  "maintenance runtime. It does not call a Core HTTP route.",
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
  getRuntime
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
  if (operation === "summary") {
    rejectUnknown(options, ["from", "to", "limit"])
    const query = parseQuery(options)
    const runtime = await getRuntime()
    return { output: `${JSON.stringify(await runtime.productionData.summary(query), null, 2)}\n` }
  }

  if (operation !== "workflow") {
    throw new MaintenanceCliError(`Unknown production-data command: ${operation}`)
  }
  rejectUnknown(options, ["correlation-id", "limit"])
  const correlationId = requiredOption(options, "correlation-id")
  const query = parseQuery(options)
  const runtime = await getRuntime()
  return {
    output: `${JSON.stringify(
      await runtime.productionData.workflow(correlationId, query.limit),
      null,
      2
    )}\n`
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
    throw new MaintenanceCliError("Production data query is invalid")
  }
}
