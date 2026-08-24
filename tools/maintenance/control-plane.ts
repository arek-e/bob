import { Schema } from "effect"
import { randomUUID } from "node:crypto"

import type { MaintenanceJobSpec } from "../../packages/runtime-control/types/src/contract.js"
import type { MaintenanceEnvironment } from "./context.js"

import { MaintenanceCliError } from "./errors.js"

export type MaintenanceOperationStatus =
  | "requested"
  | "leased"
  | "running"
  | "succeeded"
  | "failed"
  | "canceled"
  | "superseded"

export type MaintenanceOperation = Readonly<{
  readonly id: string
  readonly clusterId: string
  readonly desiredGeneration: string
  readonly type: "maintenance_job"
  readonly status: MaintenanceOperationStatus
  readonly executionId: string | null
  readonly requestedAt: string
  readonly deadlineAt: string
  readonly completedAt: string | null
}>

export type MaintenanceRuntimeTarget = Readonly<{
  readonly id: string
  readonly environment: MaintenanceEnvironment
  readonly region: string
  readonly provider: string
  readonly runtimeAdapter: string
  readonly targetReference: string
  readonly deploymentProfileId: string
  readonly accessPolicyId: string | null
  readonly source: "terraform" | "control-plane" | "manual"
  readonly sourceRevision: string | null
}>

const ControlPlaneResponse = Schema.Struct({
  desiredReleaseId: Schema.optionalKey(Schema.String),
  runtimeTarget: Schema.optionalKey(
    Schema.NullOr(
      Schema.Struct({
        id: Schema.String,
        environment: Schema.Literals(["development", "staging", "production"]),
        region: Schema.String,
        provider: Schema.String,
        runtimeAdapter: Schema.String,
        targetReference: Schema.String,
        deploymentProfileId: Schema.String,
        accessPolicyId: Schema.optionalKey(Schema.NullOr(Schema.String)),
        source: Schema.Literals(["terraform", "control-plane", "manual"]),
        sourceRevision: Schema.optionalKey(Schema.NullOr(Schema.String))
      })
    )
  ),
  operationId: Schema.optionalKey(Schema.String),
  id: Schema.optionalKey(Schema.String),
  clusterId: Schema.optionalKey(Schema.String),
  desiredGeneration: Schema.optionalKey(Schema.String),
  type: Schema.optionalKey(Schema.String),
  status: Schema.optionalKey(Schema.String),
  executionId: Schema.optionalKey(Schema.String),
  requestedAt: Schema.optionalKey(Schema.String),
  deadlineAt: Schema.optionalKey(Schema.String),
  completedAt: Schema.optionalKey(Schema.NullOr(Schema.String))
})
type ControlPlaneResponse = typeof ControlPlaneResponse.Type

export function createMaintenanceControlPlaneClient({
  env,
  fetchImplementation = fetch
}: {
  readonly env: NodeJS.ProcessEnv
  readonly fetchImplementation?: typeof fetch
}) {
  const baseUrl = readBaseUrl(env)
  const token = required(env, "BOB_MAINTENANCE_CONTROL_PLANE_TOKEN")
  if (token.length < 32)
    throw new MaintenanceCliError("BOB_MAINTENANCE_CONTROL_PLANE_TOKEN is invalid")

  const request = async (path: string, init?: RequestInit): Promise<ControlPlaneResponse> => {
    let response: Response
    try {
      const headers = new Headers(init?.headers)
      headers.set("authorization", `Bearer ${token}`)
      response = await fetchImplementation(new URL(path, `${baseUrl}/`), {
        ...init,
        headers,
        signal: init?.signal ?? AbortSignal.timeout(30_000)
      })
    } catch {
      throw new MaintenanceCliError("Control Plane request failed")
    }
    if (!response.ok) throw new MaintenanceCliError("Control Plane request was rejected")
    const text = await response.text().catch(() => "")
    if (text.length > 64 * 1024)
      throw new MaintenanceCliError("Control Plane response is too large")
    try {
      return Schema.decodeUnknownSync(ControlPlaneResponse)(JSON.parse(text))
    } catch {
      throw new MaintenanceCliError("Control Plane response is invalid")
    }
  }

  return {
    async getRuntimeTarget(clusterId: string): Promise<{
      readonly desiredReleaseId: string
      readonly target: MaintenanceRuntimeTarget
    }> {
      const body = await request(`/v1/runtime-targets/${encodeURIComponent(clusterId)}`)
      const target = body.runtimeTarget
      if (target === undefined || target === null)
        throw new MaintenanceCliError("Runtime Target is not configured")
      return {
        desiredReleaseId: requiredString(body.desiredReleaseId, "Runtime release"),
        target: {
          id: target.id,
          environment: target.environment,
          region: requiredString(target.region, "Runtime Target region"),
          provider: requiredString(target.provider, "Runtime Target provider"),
          runtimeAdapter: requiredString(target.runtimeAdapter, "Runtime Target adapter"),
          targetReference: requiredString(target.targetReference, "Runtime Target reference"),
          deploymentProfileId: requiredString(
            target.deploymentProfileId,
            "Runtime Target deployment profile"
          ),
          accessPolicyId: target.accessPolicyId ?? null,
          source: target.source,
          sourceRevision: target.sourceRevision ?? null
        }
      }
    },

    async submit(
      job: MaintenanceJobSpec,
      deadlineAt: Date
    ): Promise<{ readonly operationId: string; readonly executionId: string }> {
      const body = {
        idempotencyKey: job.executionId,
        deadlineAt: deadlineAt.toISOString(),
        executionId: job.executionId,
        environment: job.target.environment,
        deploymentProfileId: job.target.deploymentProfileId,
        releaseId: job.target.releaseId,
        image: job.image,
        command: job.command
      } satisfies Readonly<{
        readonly idempotencyKey: string
        readonly deadlineAt: string
        readonly executionId: string
        readonly environment: MaintenanceJobSpec["target"]["environment"]
        readonly deploymentProfileId: string
        readonly releaseId: string
        readonly image: MaintenanceJobSpec["image"]
        readonly command: MaintenanceJobSpec["command"]
      }>
      const response = await request(
        `/v1/runtime-clusters/${encodeURIComponent(job.target.clusterId)}/maintenance`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body)
        }
      )
      return {
        operationId: requiredString(response.operationId, "Maintenance operation ID"),
        executionId: job.executionId
      }
    },

    async getOperation(clusterId: string, operationId: string): Promise<MaintenanceOperation> {
      const response = await request(
        `/v1/runtime-clusters/${encodeURIComponent(clusterId)}/operations/${encodeURIComponent(operationId)}`
      )
      const type = requiredString(response.type, "Maintenance operation type")
      if (type !== "maintenance_job")
        throw new MaintenanceCliError("Control Plane returned a non-maintenance operation")
      return {
        id: requiredString(response.id, "Maintenance operation ID"),
        clusterId: requiredString(response.clusterId, "Maintenance cluster ID"),
        desiredGeneration: requiredString(response.desiredGeneration, "Maintenance generation"),
        type,
        status: operationStatus(response.status),
        executionId: nullableString(response.executionId),
        requestedAt: requiredString(response.requestedAt, "Maintenance request time"),
        deadlineAt: requiredString(response.deadlineAt, "Maintenance deadline"),
        completedAt: nullableString(response.completedAt)
      }
    }
  }
}

export function newMaintenanceExecutionId(): string {
  return `maintenance-${randomUUID()}`
}

function readBaseUrl(env: NodeJS.ProcessEnv): string {
  const value = required(env, "BOB_MAINTENANCE_CONTROL_PLANE_URL")
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new MaintenanceCliError("BOB_MAINTENANCE_CONTROL_PLANE_URL is invalid")
  }
  if (url.protocol !== "https:" && url.protocol !== "http:")
    throw new MaintenanceCliError("BOB_MAINTENANCE_CONTROL_PLANE_URL must use HTTP or HTTPS")
  if (url.username || url.password || url.search || url.hash)
    throw new MaintenanceCliError("BOB_MAINTENANCE_CONTROL_PLANE_URL must not contain credentials")
  return url.toString().replace(/\/$/u, "")
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]
  if (value === undefined || value.length === 0)
    throw new MaintenanceCliError(`${name} is required`)
  return value
}

function requiredString(value: string | undefined, name: string): string {
  if (value === undefined || value.length === 0) throw new MaintenanceCliError(`${name} is invalid`)
  return value
}

function nullableString(value: string | null | undefined): string | null {
  return value === null || value === undefined ? null : requiredString(value, "Control Plane value")
}

function operationStatus(value: string | undefined): MaintenanceOperationStatus {
  if (
    value !== "requested" &&
    value !== "leased" &&
    value !== "running" &&
    value !== "succeeded" &&
    value !== "failed" &&
    value !== "canceled" &&
    value !== "superseded"
  )
    throw new MaintenanceCliError("Maintenance operation status is invalid")
  return value
}
