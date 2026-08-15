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

type JsonValue = null | boolean | number | string | JsonObject | JsonValue[]

interface JsonObject {
  readonly [key: string]: JsonValue
}

const isJsonObject = (value: JsonValue): value is JsonObject =>
  value !== null && !Array.isArray(value) && Object(value) === value

const requiredObject = (value: JsonValue, name: string): JsonObject => {
  if (!isJsonObject(value)) throw new Error(`${name} is invalid`)
  return value
}

const requiredString = (value: JsonValue | undefined, name: string): string => {
  if (Object.prototype.toString.call(value) !== "[object String]") {
    throw new Error(`${name} is invalid`)
  }
  return String(value)
}

const stringArray = (value: JsonValue | undefined, name: string): ReadonlyArray<string> => {
  if (
    !Array.isArray(value) ||
    value.some((item) => Object.prototype.toString.call(item) !== "[object String]")
  ) {
    throw new Error(`${name} is invalid`)
  }
  return value.map(String)
}

const jsonValue = <Input>(value: Input): JsonValue => {
  const encoded = JSON.stringify(value)
  if (encoded === undefined) throw new Error("Deployment contract is required")
  return JSON.parse(encoded)
}

export function validateDeploymentContract<Input>(value: Input): RuntimeDeploymentContract {
  const contract = requiredObject(jsonValue(value), "Deployment contract")
  if (contract.schemaVersion !== DEPLOYMENT_SCHEMA_VERSION) {
    throw new Error("Deployment contract schema is unsupported")
  }
  const composeFile = requiredString(contract.composeFile, "Deployment contract Compose path")
  if (composeFile.length === 0 || composeFile.startsWith("/") || composeFile.includes("..")) {
    throw new Error("Deployment contract Compose path is invalid")
  }
  const composeDigest = requiredString(contract.composeDigest, "Deployment contract Compose digest")
  if (!/^sha256:[0-9a-f]{64}$/.test(composeDigest)) {
    throw new Error("Deployment contract Compose digest is invalid")
  }
  const readinessPath = requiredString(contract.readinessPath, "Deployment readiness path")
  if (!readinessPath.startsWith("/") || readinessPath.includes("..")) {
    throw new Error("Deployment contract readiness path is invalid")
  }
  if (
    !Array.isArray(contract.services) ||
    contract.services.length === 0 ||
    contract.services.length > 32
  )
    throw new Error("Deployment contract services are invalid")
  const names = new Set<string>()
  const services = contract.services.map((value): RuntimeServiceContract => {
    const service = requiredObject(value, "Deployment contract service")
    const name = requiredString(service.name, "Deployment contract service name")
    const imageName = requiredString(service.imageName, "Deployment contract image name")
    const imageEnvironmentVariable = requiredString(
      service.imageEnvironmentVariable,
      "Deployment contract image variable"
    )
    if (
      !namePattern.test(name) ||
      !namePattern.test(imageName) ||
      !/^[A-Z][A-Z0-9_]{0,127}$/.test(imageEnvironmentVariable) ||
      names.has(name)
    ) {
      throw new Error("Deployment contract service name is invalid")
    }
    names.add(name)
    return {
      name,
      imageName,
      imageEnvironmentVariable,
      requiredConfiguration: stringArray(
        service.requiredConfiguration,
        "Deployment contract configuration"
      ),
      requiredSecrets: stringArray(service.requiredSecrets, "Deployment contract secrets")
    }
  })
  const backupCommand = stringArray(contract.backupCommand, "Deployment contract backup command")
  if (backupCommand.length === 0) {
    throw new Error("Deployment contract backup command is invalid")
  }
  return {
    schemaVersion: DEPLOYMENT_SCHEMA_VERSION,
    composeFile,
    composeDigest,
    services,
    readinessPath,
    backupCommand
  }
}

const canonicalize = (value: JsonValue): JsonValue => {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (isJsonObject(value))
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalize(item)])
    )
  return value
}

export function deploymentContractDigest(contract: RuntimeDeploymentContract): string {
  const validated = validateDeploymentContract(contract)
  const bytes = JSON.stringify(canonicalize(jsonValue(validated)))
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`
}
