import { Context, Effect, Schema } from "effect"

const Identifier = Schema.String.check(
  Schema.isPattern(/^[a-z][a-z0-9-]{0,62}$/),
  Schema.isMaxLength(63)
)
const Digest = Schema.String.check(Schema.isPattern(/^sha256:[0-9a-f]{64}$/))
const GitRevision = Schema.String.check(Schema.isPattern(/^[0-9a-f]{40}$/))
const PositiveInt = Schema.Int.check(Schema.isGreaterThan(0))
const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
const IsoDateTime = Schema.String.check(
  Schema.makeFilter((value) =>
    Number.isNaN(Date.parse(value)) ? { path: [], issue: "expected an ISO date-time" } : undefined
  )
)

export const RuntimeRoleId = Schema.Literals([
  "core-api",
  "core-finalizer",
  "agent-worker",
  "channel-ingress",
  "channel-egress",
  "scheduler",
  "migration"
])

export const RuntimeProtocolRange = Schema.Struct({
  minimum: PositiveInt,
  maximum: PositiveInt
}).check(
  Schema.makeFilter((range) =>
    range.minimum > range.maximum
      ? { path: ["maximum"], issue: "maximum precedes minimum" }
      : undefined
  )
)

export const RuntimeRoleContract = Schema.Struct({
  roleId: RuntimeRoleId,
  imageName: Identifier,
  imageDigest: Digest,
  mode: Schema.Literals(["scalable", "singleton", "job"]),
  defaultReplicas: NonNegativeInt,
  maximumReplicas: PositiveInt,
  executionSlotsPerReplica: NonNegativeInt,
  readinessPath: Schema.optionalKey(Schema.String.check(Schema.isPattern(/^\/[a-z0-9/_-]*$/))),
  dependencies: Schema.Array(Schema.Literals(["postgresql", "redis", "object-storage", "openbao"]))
}).check(
  Schema.makeFilter((role) => {
    if (role.defaultReplicas > role.maximumReplicas) {
      return { path: ["defaultReplicas"], issue: "default replicas exceed maximum replicas" }
    }
    if (role.mode !== "scalable" && role.maximumReplicas !== 1) {
      return { path: ["maximumReplicas"], issue: "non-scalable roles have one replica" }
    }
    if (role.roleId === "agent-worker" && role.executionSlotsPerReplica === 0) {
      return { path: ["executionSlotsPerReplica"], issue: "Agent Workers require execution slots" }
    }
    if (role.roleId !== "agent-worker" && role.executionSlotsPerReplica !== 0) {
      return {
        path: ["executionSlotsPerReplica"],
        issue: "only Agent Workers expose execution slots"
      }
    }
    return undefined
  })
)

export const RuntimeReleaseContract = Schema.Struct({
  schemaVersion: Schema.Literal("bob.runtime-control.v1"),
  releaseId: Identifier,
  sourceRevision: GitRevision,
  deploymentProfileId: Identifier,
  capabilityCatalogueGeneration: Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(128)
  ),
  executionPoolId: Identifier,
  roles: Schema.Array(RuntimeRoleContract).check(
    Schema.isMinLength(1),
    Schema.makeFilter((roles) =>
      new Set(roles.map((role) => role.roleId)).size === roles.length
        ? undefined
        : { path: [], issue: "role identifiers must be unique" }
    )
  ),
  protocols: Schema.Struct({
    agentRunJob: RuntimeProtocolRange,
    coreGateway: RuntimeProtocolRange,
    checkpointLoop: RuntimeProtocolRange
  }),
  database: Schema.Struct({
    schemaVersion: PositiveInt,
    minimumCompatibleSchemaVersion: PositiveInt,
    minimumRollbackSchemaVersion: PositiveInt,
    migrationMode: Schema.Literals(["expand", "contract", "none"])
  }),
  requiredSharedServices: Schema.Array(
    Schema.Literals(["postgresql", "redis", "object-storage"])
  ).check(
    Schema.makeFilter((services) =>
      services.length === new Set(services).size
        ? undefined
        : { path: [], issue: "services must be unique" }
    )
  )
})

export const RuntimeRoleObservation = Schema.Struct({
  roleId: RuntimeRoleId,
  desiredReplicas: NonNegativeInt,
  readyReplicas: NonNegativeInt,
  drainingReplicas: NonNegativeInt,
  availableExecutionSlots: NonNegativeInt,
  executionPoolId: Schema.optionalKey(Identifier),
  releaseId: Identifier
}).check(
  Schema.makeFilter((role) =>
    role.readyReplicas + role.drainingReplicas > role.desiredReplicas
      ? { path: ["readyReplicas"], issue: "observed replicas exceed desired replicas" }
      : undefined
  )
)

export const RuntimeCondition = Schema.Struct({
  code: Identifier,
  status: Schema.Literals(["true", "false", "unknown"]),
  observedAt: IsoDateTime
})

export const RuntimeClusterObservation = Schema.Struct({
  schemaVersion: Schema.Literal("bob.runtime-observation.v1"),
  clusterId: Identifier,
  desiredGeneration: NonNegativeInt,
  observedGeneration: NonNegativeInt,
  releaseId: Identifier,
  databaseSchemaVersion: PositiveInt,
  oldestAgentRunAgeMs: NonNegativeInt,
  pendingAgentRuns: NonNegativeInt,
  roles: Schema.Array(RuntimeRoleObservation),
  conditions: Schema.Array(RuntimeCondition),
  observedAt: IsoDateTime
})

export type RuntimeRoleId = typeof RuntimeRoleId.Type
export type RuntimeProtocolRange = typeof RuntimeProtocolRange.Type
export type RuntimeRoleContract = typeof RuntimeRoleContract.Type
export type RuntimeReleaseContract = typeof RuntimeReleaseContract.Type
export type RuntimeRoleObservation = typeof RuntimeRoleObservation.Type
export type RuntimeCondition = typeof RuntimeCondition.Type
export type RuntimeClusterObservation = typeof RuntimeClusterObservation.Type

export class RuntimeControlError extends Schema.TaggedError<RuntimeControlError>()(
  "RuntimeControlError",
  { operation: Schema.String, cause: Schema.Unknown }
) {}

export interface RuntimeControlService {
  readonly releaseContract: Effect.Effect<RuntimeReleaseContract, RuntimeControlError>
  readonly observe: Effect.Effect<RuntimeClusterObservation, RuntimeControlError>
}

export class RuntimeControl extends Context.Service<RuntimeControl, RuntimeControlService>()(
  "@bob/runtime-control/RuntimeControl"
) {}
