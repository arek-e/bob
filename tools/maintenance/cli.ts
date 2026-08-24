import type { MaintenanceExecutionContext } from "./context.js"

import { readMaintenanceExecutionContext } from "./context.js"
import { MaintenanceCliError } from "./errors.js"
import {
  executeAgentMaintenance,
  isRemoteMaintenanceCommand,
  resolveAgentMaintenanceContext
} from "./remote.js"

export { MaintenanceCliError } from "./errors.js"

export type MaintenanceCommandContext = {
  readonly argv: readonly string[]
  readonly env: NodeJS.ProcessEnv
  readonly executionContext: MaintenanceExecutionContext
  readonly getRuntime: () => Promise<import("./runtime.js").MaintenanceRuntime>
}

export type MaintenanceCommandResult = {
  readonly output: string
}

type MaintenanceGlobalOptions = Readonly<{
  readonly context?: string
  readonly image?: string
}>

type MutableMaintenanceGlobalOptions = {
  context?: string
  image?: string
}

type MaintenanceInvocation = Readonly<{
  readonly commandName: string | undefined
  readonly commandArguments: readonly string[]
  readonly globalOptions: MaintenanceGlobalOptions
}>

const MAINTENANCE_GLOBAL_OPTION_LINES = [
  "  --context <cluster-id>       Target Runtime Cluster identifier.",
  "  --image <64-hex>             Core project image digest hex."
] as const

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

export async function runMaintenanceCli({
  argv,
  commands,
  env,
  createRuntime = (runtimeEnvironment, executionContext) =>
    import("./runtime.js").then(({ createMaintenanceRuntime }) =>
      createMaintenanceRuntime({ env: runtimeEnvironment, executionContext })
    )
}: {
  readonly argv: readonly string[]
  readonly commands: readonly MaintenanceCommand[]
  readonly env: NodeJS.ProcessEnv
  readonly createRuntime?: (
    env: NodeJS.ProcessEnv,
    executionContext: MaintenanceExecutionContext
  ) => Promise<import("./runtime.js").MaintenanceRuntime>
}): Promise<MaintenanceExecution> {
  let parsedArguments: {
    readonly commandName: string | undefined
    readonly commandArguments: readonly string[]
    readonly globalOptions: MaintenanceGlobalOptions
  }
  try {
    parsedArguments = parseInvocation(argv)
  } catch (error) {
    if (error instanceof MaintenanceCliError) return failure(error.message)
    return failure("Maintenance command options are invalid")
  }
  const { commandName, commandArguments, globalOptions } = parsedArguments

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
    return success(renderCommandHelp(command))
  }

  let commandEnvironment: NodeJS.ProcessEnv
  try {
    commandEnvironment = applyGlobalOptions(env, globalOptions, commandName)
  } catch (error) {
    if (error instanceof MaintenanceCliError) return failure(error.message)
    return failure("Maintenance command options are invalid")
  }

  let executionContext: MaintenanceExecutionContext
  try {
    if (
      isRemoteMaintenanceCommand(commandName) &&
      commandEnvironment.BOB_MAINTENANCE_MODE === "agent"
    ) {
      if (globalOptions.context === undefined)
        throw new MaintenanceCliError("Agent mode needs --context <cluster-id>")
      const clusterId = commandEnvironment.BOB_MAINTENANCE_CLUSTER_ID
      if (clusterId === undefined || clusterId.length === 0)
        throw new MaintenanceCliError("Agent mode needs --context <cluster-id>")
      const clusterContext = await resolveAgentMaintenanceContext({
        env: commandEnvironment,
        clusterId
      })
      commandEnvironment.BOB_MAINTENANCE_ENVIRONMENT = clusterContext.target.environment
      commandEnvironment.BOB_MAINTENANCE_DEPLOYMENT_PROFILE_ID =
        clusterContext.target.deploymentProfileId
      commandEnvironment.BOB_MAINTENANCE_RELEASE_ID = clusterContext.desiredReleaseId
      commandEnvironment.BOB_MAINTENANCE_TARGET_REGION = clusterContext.target.region
      commandEnvironment.BOB_MAINTENANCE_TARGET_PROVIDER = clusterContext.target.provider
      commandEnvironment.BOB_MAINTENANCE_RUNTIME_ADAPTER = clusterContext.target.runtimeAdapter
      commandEnvironment.BOB_MAINTENANCE_TARGET_REFERENCE = clusterContext.target.targetReference
      commandEnvironment.BOB_MAINTENANCE_TARGET_ACCESS_POLICY_ID =
        clusterContext.target.accessPolicyId ?? ""
      commandEnvironment.BOB_MAINTENANCE_TARGET_SOURCE = clusterContext.target.source
      commandEnvironment.BOB_MAINTENANCE_TARGET_SOURCE_REVISION =
        clusterContext.target.sourceRevision ?? ""
    }
    executionContext = readMaintenanceExecutionContext(commandEnvironment)
  } catch (error) {
    if (error instanceof MaintenanceCliError) return failure(error.message)
    return failure("Maintenance execution context is invalid")
  }

  let runtime: import("./runtime.js").MaintenanceRuntime | undefined
  const getRuntime = async () => {
    runtime ??= await createRuntime(commandEnvironment, executionContext)
    return runtime
  }

  try {
    const result =
      executionContext.mode === "agent" && isRemoteMaintenanceCommand(commandName)
        ? await executeAgentMaintenance({
            commandName,
            commandArguments,
            env: commandEnvironment,
            executionContext
          })
        : await command.run({
            argv: commandArguments,
            env: commandEnvironment,
            executionContext,
            getRuntime
          })
    return success(result.output)
  } catch (error) {
    if (error instanceof MaintenanceCliError) return failure(error.message)
    return failure("Maintenance command failed")
  } finally {
    await runtime?.dispose()
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
    "Usage: pnpm maint [global-options] <command> [options]",
    "",
    "Global options:",
    ...MAINTENANCE_GLOBAL_OPTION_LINES,
    "",
    "Commands:",
    ...commandLines,
    "",
    "Use `pnpm maint <command> --help` for command details.",
    ""
  ].join("\n")
}

function renderCommandHelp(command: MaintenanceCommand): string {
  return [
    command.help.trimEnd(),
    "",
    "Common options:",
    ...MAINTENANCE_GLOBAL_OPTION_LINES,
    ""
  ].join("\n")
}

function parseInvocation(argv: readonly string[]): MaintenanceInvocation {
  const commandArguments: string[] = []
  let context: string | undefined
  let image: string | undefined
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === undefined) continue
    if (argument === "--environment" || argument === "--deployment-profile")
      throw new MaintenanceCliError(`${argument} was removed; use --context <cluster-id>`)
    if (argument === "--context" || argument === "--image") {
      const value = argv[index + 1]
      if (value === undefined || value.startsWith("--")) {
        throw new MaintenanceCliError(`${argument} needs a value`)
      }
      if (argument === "--context") {
        if (context !== undefined)
          throw new MaintenanceCliError("--context was provided more than once")
        context = value
      } else {
        if (image !== undefined)
          throw new MaintenanceCliError("--image was provided more than once")
        image = value
      }
      index += 1
      continue
    }
    commandArguments.push(argument)
  }
  const [commandName, ...remainingArguments] = commandArguments
  const globalOptions: MutableMaintenanceGlobalOptions = {}
  if (context !== undefined) globalOptions.context = context
  if (image !== undefined) globalOptions.image = image
  return {
    commandName,
    commandArguments: remainingArguments,
    globalOptions
  }
}

function applyGlobalOptions(
  env: NodeJS.ProcessEnv,
  options: MaintenanceGlobalOptions,
  commandName: string
): NodeJS.ProcessEnv {
  const commandEnvironment = { ...env }
  if (options.context !== undefined) {
    if (!CONTEXT_IDENTIFIER.test(options.context))
      throw new MaintenanceCliError("--context must be a valid cluster identifier")
    assertJobOverrideMatches(env, "BOB_MAINTENANCE_CLUSTER_ID", options.context, "--context")
    commandEnvironment.BOB_MAINTENANCE_CLUSTER_ID = options.context
  }
  if (options.image !== undefined) {
    const imageDigest = normalizeImageDigest(options.image)
    assertJobOverrideMatches(env, "BOB_MAINTENANCE_IMAGE_DIGEST", imageDigest, "--image")
    commandEnvironment.BOB_MAINTENANCE_IMAGE_DIGEST = imageDigest
    if (env.BOB_MAINTENANCE_MODE !== "cluster-job") {
      commandEnvironment.BOB_MAINTENANCE_IMAGE_SOURCE = "pinned-image"
    }
  }
  const remoteRequested =
    (isRemoteMaintenanceCommand(commandName) &&
      (options.context !== undefined ||
        options.image !== undefined ||
        env.BOB_MAINTENANCE_MODE === "agent")) ||
    env.BOB_MAINTENANCE_MODE === "cluster-job"
  if (commandEnvironment.BOB_MAINTENANCE_MODE === undefined) {
    commandEnvironment.BOB_MAINTENANCE_MODE = remoteRequested ? "agent" : "local"
  } else if (remoteRequested && commandEnvironment.BOB_MAINTENANCE_MODE !== "cluster-job") {
    commandEnvironment.BOB_MAINTENANCE_MODE = "agent"
  }
  if (!remoteRequested) {
    commandEnvironment.BOB_MAINTENANCE_ENVIRONMENT ??= "development"
    commandEnvironment.BOB_MAINTENANCE_CLUSTER_ID ??= "local"
    commandEnvironment.BOB_MAINTENANCE_DEPLOYMENT_PROFILE_ID ??= "core"
  }
  return commandEnvironment
}

function normalizeImageDigest(value: string): string {
  if (!IMAGE_HEX.test(value)) {
    throw new MaintenanceCliError("--image must be exactly 64 hexadecimal characters")
  }
  return `sha256:${value.toLowerCase()}`
}

const IMAGE_HEX = /^[0-9a-f]{64}$/iu
const CONTEXT_IDENTIFIER = /^[a-z][a-z0-9-]{0,62}$/u

function assertJobOverrideMatches(
  env: NodeJS.ProcessEnv,
  name: string,
  value: string,
  option: string
): void {
  if (env.BOB_MAINTENANCE_MODE === "cluster-job" && env[name] !== value) {
    throw new MaintenanceCliError(`${option} must match ${name} for a cluster job`)
  }
}
