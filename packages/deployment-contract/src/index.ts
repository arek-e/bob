import { createHash } from "node:crypto"

export const DEPLOYMENT_SCHEMA_VERSION = "bob.runtime.v1alpha1" as const

export interface RuntimeServiceContract {
  readonly name: string
  readonly imageName: string
  readonly imageEnvironmentVariable: string
  readonly requiredConfiguration: ReadonlyArray<string>
  readonly requiredSecrets: ReadonlyArray<string>
}

export interface RuntimeDeploymentContract {
  readonly schemaVersion: typeof DEPLOYMENT_SCHEMA_VERSION
  readonly composeFile: string
  readonly composeDigest: string
  readonly services: ReadonlyArray<RuntimeServiceContract>
  readonly readinessPath: string
  readonly backupCommand: ReadonlyArray<string>
}

const namePattern = /^[a-z][a-z0-9-]{0,62}$/

export function validateDeploymentContract(value: unknown): RuntimeDeploymentContract {
  if (!value || typeof value !== "object") throw new Error("Deployment contract is required")
  const contract = value as Partial<RuntimeDeploymentContract>
  if (contract.schemaVersion !== DEPLOYMENT_SCHEMA_VERSION)
    throw new Error("Deployment contract schema is unsupported")
  if (
    !contract.composeFile ||
    contract.composeFile.startsWith("/") ||
    contract.composeFile.includes("..")
  )
    throw new Error("Deployment contract Compose path is invalid")
  if (!/^sha256:[0-9a-f]{64}$/.test(contract.composeDigest ?? ""))
    throw new Error("Deployment contract Compose digest is invalid")
  if (!contract.readinessPath?.startsWith("/") || contract.readinessPath.includes(".."))
    throw new Error("Deployment contract readiness path is invalid")
  if (
    !Array.isArray(contract.services) ||
    contract.services.length === 0 ||
    contract.services.length > 32
  )
    throw new Error("Deployment contract services are invalid")
  const names = new Set<string>()
  for (const service of contract.services) {
    if (
      !namePattern.test(service.name) ||
      !namePattern.test(service.imageName) ||
      !/^[A-Z][A-Z0-9_]{0,127}$/.test(service.imageEnvironmentVariable) ||
      names.has(service.name)
    )
      throw new Error("Deployment contract service name is invalid")
    names.add(service.name)
    if (!Array.isArray(service.requiredConfiguration) || !Array.isArray(service.requiredSecrets))
      throw new Error("Deployment contract inputs are invalid")
  }
  if (!Array.isArray(contract.backupCommand) || contract.backupCommand.length === 0)
    throw new Error("Deployment contract backup command is invalid")
  return contract as RuntimeDeploymentContract
}

const canonicalize = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalize(item)])
    )
  return value
}

export function deploymentContractDigest(contract: RuntimeDeploymentContract): string {
  validateDeploymentContract(contract)
  const bytes = JSON.stringify(canonicalize(contract))
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`
}
