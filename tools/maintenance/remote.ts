import type { MaintenanceJobSpec } from "../../packages/runtime-control/types/src/contract.js"
import type { MaintenanceCommandContext, MaintenanceCommandResult } from "./cli.js"

import { createMaintenanceControlPlaneClient, newMaintenanceExecutionId } from "./control-plane.js"
import { MaintenanceCliError } from "./errors.js"

const remoteCommandNames = new Set([
  "migrate",
  "read-latest-messages",
  "read-all-messages",
  "summarize-activity",
  "inspect-workflow"
])

export function isRemoteMaintenanceCommand(commandName: string): boolean {
  return remoteCommandNames.has(commandName)
}

export async function resolveAgentMaintenanceContext({
  env,
  clusterId
}: {
  readonly env: NodeJS.ProcessEnv
  readonly clusterId: string
}) {
  return createMaintenanceControlPlaneClient({ env }).getRuntimeTarget(clusterId)
}

export async function executeAgentMaintenance({
  commandName,
  commandArguments,
  env,
  executionContext
}: Pick<MaintenanceCommandContext, "env" | "executionContext"> & {
  readonly commandName: string
  readonly commandArguments: readonly string[]
}): Promise<MaintenanceCommandResult> {
  if (!remoteCommandNames.has(commandName))
    throw new MaintenanceCliError("This maintenance command cannot run in agent mode")
  if (commandArguments.includes("--help") || commandArguments.includes("-h"))
    throw new MaintenanceCliError("Help commands cannot run in agent mode")
  const image = executionContext.image
  if (image === undefined)
    throw new MaintenanceCliError("Agent mode needs --image with 64 hexadecimal characters")
  const client = createMaintenanceControlPlaneClient({ env })
  const executionId = executionContext.executionId ?? newMaintenanceExecutionId()
  const releaseId =
    executionContext.releaseId ??
    (await client.getRuntimeTarget(executionContext.clusterId)).desiredReleaseId
  const job: MaintenanceJobSpec = {
    schemaVersion: "bob.maintenance-job.v1",
    executionId,
    target: {
      environment: executionContext.environment,
      clusterId: executionContext.clusterId,
      deploymentProfileId: executionContext.deploymentProfileId,
      releaseId
    },
    image,
    command: { name: commandName, arguments: commandArguments }
  }
  const operation = await client.submit(job, new Date(Date.now() + 20 * 60_000))
  return {
    output: `${JSON.stringify(
      {
        executionId: operation.executionId,
        operationId: operation.operationId,
        clusterId: job.target.clusterId,
        command: commandName,
        status: "requested"
      },
      null,
      2
    )}\n`
  }
}
