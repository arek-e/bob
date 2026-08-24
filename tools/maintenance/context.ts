import { MaintenanceCliError } from "./errors.js"

const IDENTIFIER = /^[a-z][a-z0-9-]{0,62}$/u
const RELEASE_IDENTIFIER = /^[a-z0-9][a-z0-9-]{0,62}$/u

export const MAINTENANCE_CONTEXT_SCHEMA_VERSION = "bob.maintenance-context.v1" as const

export type MaintenanceEnvironment = "development" | "staging" | "production"
export type MaintenanceExecutionMode = "local" | "agent" | "cluster-job"
export type MaintenanceImageSource = "runtime-release" | "commit-build" | "pinned-image"
export type MaintenanceRuntimeTargetSource = "terraform" | "control-plane" | "manual"

export type MaintenanceRuntimeTarget = Readonly<{
  readonly region: string
  readonly provider: string
  readonly runtimeAdapter: string
  readonly targetReference: string
  readonly accessPolicyId?: string
  readonly source: MaintenanceRuntimeTargetSource
  readonly sourceRevision?: string
}>

export type MaintenanceImageContext = Readonly<{
  readonly name: "core"
  readonly source: MaintenanceImageSource
  readonly digest: string
  readonly sourceRevision?: string
}>

export type MaintenanceExecutionContext = Readonly<{
  readonly schemaVersion: typeof MAINTENANCE_CONTEXT_SCHEMA_VERSION
  readonly environment: MaintenanceEnvironment
  readonly clusterId: string
  readonly deploymentProfileId: string
  readonly mode: MaintenanceExecutionMode
  readonly runtimeTarget?: MaintenanceRuntimeTarget
  readonly image?: MaintenanceImageContext
  readonly releaseId?: string
  readonly executionId?: string
}>

export function readMaintenanceExecutionContext(
  env: NodeJS.ProcessEnv
): MaintenanceExecutionContext {
  const environment = requiredEnvironment(env, "BOB_MAINTENANCE_ENVIRONMENT")
  if (!isMaintenanceEnvironment(environment)) {
    throw new MaintenanceCliError("BOB_MAINTENANCE_ENVIRONMENT is invalid")
  }

  const clusterId = requiredIdentifier(env, "BOB_MAINTENANCE_CLUSTER_ID")
  const deploymentProfileId = requiredIdentifier(env, "BOB_MAINTENANCE_DEPLOYMENT_PROFILE_ID")
  const mode = requiredEnvironment(env, "BOB_MAINTENANCE_MODE")
  if (!isMaintenanceExecutionMode(mode)) {
    throw new MaintenanceCliError("BOB_MAINTENANCE_MODE is invalid")
  }

  const releaseId = optionalReleaseIdentifier(env, "BOB_MAINTENANCE_RELEASE_ID")
  const executionId = optionalIdentifier(env, "BOB_MAINTENANCE_EXECUTION_ID")
  if (mode === "cluster-job" && (releaseId === undefined || executionId === undefined)) {
    throw new MaintenanceCliError(
      "Cluster maintenance jobs require BOB_MAINTENANCE_RELEASE_ID and BOB_MAINTENANCE_EXECUTION_ID"
    )
  }
  const runtimeTarget = readRuntimeTarget(env, mode)
  const image = readImageContext(env, mode)

  const context: MutableMaintenanceExecutionContext = {
    schemaVersion: MAINTENANCE_CONTEXT_SCHEMA_VERSION,
    environment,
    clusterId,
    deploymentProfileId,
    mode
  }
  if (runtimeTarget !== undefined) context.runtimeTarget = runtimeTarget
  if (image !== undefined) context.image = image
  if (releaseId !== undefined) context.releaseId = releaseId
  if (executionId !== undefined) context.executionId = executionId
  return Object.freeze(context)
}

function readRuntimeTarget(
  env: NodeJS.ProcessEnv,
  mode: MaintenanceExecutionMode
): MaintenanceRuntimeTarget | undefined {
  const values = {
    region: env.BOB_MAINTENANCE_TARGET_REGION,
    provider: env.BOB_MAINTENANCE_TARGET_PROVIDER,
    runtimeAdapter: env.BOB_MAINTENANCE_RUNTIME_ADAPTER,
    targetReference: env.BOB_MAINTENANCE_TARGET_REFERENCE,
    accessPolicyId: optionalIdentifier(env, "BOB_MAINTENANCE_TARGET_ACCESS_POLICY_ID"),
    source: env.BOB_MAINTENANCE_TARGET_SOURCE,
    sourceRevision: optionalTargetSourceRevision(env)
  }
  const anyValue =
    values.region !== undefined ||
    values.provider !== undefined ||
    values.runtimeAdapter !== undefined ||
    values.targetReference !== undefined ||
    values.accessPolicyId !== undefined ||
    values.source !== undefined ||
    values.sourceRevision !== undefined
  if (!anyValue) {
    if (mode === "local") return undefined
    throw new MaintenanceCliError(
      "Cluster maintenance jobs require the resolved Runtime Target context"
    )
  }
  if (
    values.region === undefined ||
    !IDENTIFIER.test(values.region) ||
    values.provider === undefined ||
    !IDENTIFIER.test(values.provider) ||
    values.runtimeAdapter === undefined ||
    !IDENTIFIER.test(values.runtimeAdapter) ||
    values.targetReference === undefined ||
    !isBoundedReference(values.targetReference) ||
    values.source === undefined ||
    !isMaintenanceRuntimeTargetSource(values.source)
  ) {
    throw new MaintenanceCliError("Maintenance Runtime Target context is invalid")
  }
  const runtimeTarget: MutableMaintenanceRuntimeTarget = {
    region: values.region,
    provider: values.provider,
    runtimeAdapter: values.runtimeAdapter,
    targetReference: values.targetReference,
    source: values.source
  }
  if (values.accessPolicyId !== undefined) runtimeTarget.accessPolicyId = values.accessPolicyId
  if (values.sourceRevision !== undefined) runtimeTarget.sourceRevision = values.sourceRevision
  return Object.freeze(runtimeTarget)
}

function isMaintenanceRuntimeTargetSource(value: string): value is MaintenanceRuntimeTargetSource {
  return value === "terraform" || value === "control-plane" || value === "manual"
}

function isBoundedReference(value: string): boolean {
  return value.length > 0 && value.length <= 256 && !hasControlCharacter(value)
}

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0)
    return codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f)
  })
}

function isMaintenanceEnvironment(value: string): value is MaintenanceEnvironment {
  return value === "development" || value === "staging" || value === "production"
}

function isMaintenanceExecutionMode(value: string): value is MaintenanceExecutionMode {
  return value === "local" || value === "agent" || value === "cluster-job"
}

function readImageContext(
  env: NodeJS.ProcessEnv,
  mode: MaintenanceExecutionMode
): MaintenanceImageContext | undefined {
  const sourceValue = env.BOB_MAINTENANCE_IMAGE_SOURCE
  const digestValue = env.BOB_MAINTENANCE_IMAGE_DIGEST
  const sourceRevision = optionalSourceRevision(env)
  if (sourceValue === undefined || sourceValue.length === 0) {
    if (digestValue !== undefined && digestValue.length > 0) {
      throw new MaintenanceCliError("BOB_MAINTENANCE_IMAGE_SOURCE is required")
    }
    if (sourceRevision !== undefined) {
      throw new MaintenanceCliError("BOB_MAINTENANCE_IMAGE_SOURCE is required")
    }
    if (mode === "cluster-job") {
      throw new MaintenanceCliError(
        "Cluster maintenance jobs require BOB_MAINTENANCE_IMAGE_SOURCE and BOB_MAINTENANCE_IMAGE_DIGEST"
      )
    }
    return undefined
  }
  if (!isMaintenanceImageSource(sourceValue)) {
    throw new MaintenanceCliError("BOB_MAINTENANCE_IMAGE_SOURCE is invalid")
  }
  if (digestValue === undefined || digestValue.length === 0) {
    throw new MaintenanceCliError("BOB_MAINTENANCE_IMAGE_DIGEST is required")
  }
  if (!IMAGE_DIGEST.test(digestValue)) {
    throw new MaintenanceCliError("BOB_MAINTENANCE_IMAGE_DIGEST must use sha256:<64-hex>")
  }
  if (sourceValue === "commit-build" && sourceRevision === undefined) {
    throw new MaintenanceCliError(
      "Commit-built Core images require BOB_MAINTENANCE_SOURCE_REVISION"
    )
  }
  if (sourceValue !== "commit-build" && sourceRevision !== undefined) {
    throw new MaintenanceCliError(
      "BOB_MAINTENANCE_SOURCE_REVISION is only valid for commit-built images"
    )
  }
  const image: MutableMaintenanceImageContext = {
    name: "core",
    source: sourceValue,
    digest: digestValue
  }
  if (sourceRevision !== undefined) image.sourceRevision = sourceRevision
  return Object.freeze(image)
}

function isMaintenanceImageSource(value: string): value is MaintenanceImageSource {
  return value === "runtime-release" || value === "commit-build" || value === "pinned-image"
}

const IMAGE_DIGEST = /^sha256:[0-9a-f]{64}$/u

type MutableMaintenanceImageContext = {
  -readonly [Key in keyof MaintenanceImageContext]: MaintenanceImageContext[Key]
}

type MutableMaintenanceExecutionContext = {
  -readonly [Key in keyof MaintenanceExecutionContext]: MaintenanceExecutionContext[Key]
}

type MutableMaintenanceRuntimeTarget = {
  -readonly [Key in keyof MaintenanceRuntimeTarget]: MaintenanceRuntimeTarget[Key]
}

function optionalSourceRevision(env: NodeJS.ProcessEnv): string | undefined {
  const value = env.BOB_MAINTENANCE_SOURCE_REVISION
  if (value === undefined || value.length === 0) return undefined
  if (!/^[0-9a-f]{40}$/u.test(value)) {
    throw new MaintenanceCliError("BOB_MAINTENANCE_SOURCE_REVISION is invalid")
  }
  return value
}

function requiredIdentifier(env: NodeJS.ProcessEnv, name: string): string {
  const value = requiredEnvironment(env, name)
  if (!IDENTIFIER.test(value)) throw new MaintenanceCliError(`${name} is invalid`)
  return value
}

function optionalIdentifier(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name]
  if (value === undefined || value.length === 0) return undefined
  if (!IDENTIFIER.test(value)) throw new MaintenanceCliError(`${name} is invalid`)
  return value
}

function optionalReleaseIdentifier(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name]
  if (value === undefined || value.length === 0) return undefined
  if (!RELEASE_IDENTIFIER.test(value)) throw new MaintenanceCliError(`${name} is invalid`)
  return value
}

function optionalTargetSourceRevision(env: NodeJS.ProcessEnv): string | undefined {
  const value = env.BOB_MAINTENANCE_TARGET_SOURCE_REVISION
  if (value === undefined || value.length === 0) return undefined
  if (!/^[a-zA-Z0-9._:/-]{1,256}$/u.test(value))
    throw new MaintenanceCliError("BOB_MAINTENANCE_TARGET_SOURCE_REVISION is invalid")
  return value
}

function requiredEnvironment(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]
  if (value === undefined || value.length === 0) {
    throw new MaintenanceCliError(`${name} is required`)
  }
  return value
}
