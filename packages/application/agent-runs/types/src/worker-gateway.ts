import { AgentRunOperation, AgentRunRequest, AgentRunResult } from "@bob/agent-types/run"
import { IsoDateTime, Uuid } from "@bob/shared-types/shared"
import { Context, Effect, Schema } from "effect"

const PositiveInt = Schema.Int.check(Schema.isGreaterThan(0))
const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
const Identifier = Schema.String.check(
  Schema.isPattern(/^[a-z][a-z0-9-]{0,62}$/),
  Schema.isMaxLength(63)
)

export const AgentRunJob = Schema.Struct({
  wireVersion: Schema.Literal(1),
  runId: Uuid,
  dispatchGeneration: PositiveInt,
  executionPoolId: Identifier,
  enqueuedAt: Schema.optionalKey(IsoDateTime),
  traceparent: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(512)))
})

export const AgentRunContinuationJob = Schema.Struct({
  wireVersion: Schema.Literal(1),
  runId: Uuid,
  generation: PositiveInt
})

export const AgentRunAttemptAuthority = Schema.Struct({
  runId: Uuid,
  attemptId: Uuid,
  attemptFence: PositiveInt,
  controlRevision: NonNegativeInt,
  leaseExpiresAt: IsoDateTime
})

export const AcquireAgentRun = Schema.Struct({
  job: AgentRunJob,
  workerId: Identifier,
  leaseMs: PositiveInt
})

export const AcquiredAgentRun = Schema.Struct({
  state: Schema.Literal("acquired"),
  authority: AgentRunAttemptAuthority,
  request: AgentRunRequest,
  checkpoints: Schema.Array(AgentRunOperation)
})

export const AgentRunNotEligible = Schema.Struct({
  state: Schema.Literal("not_eligible"),
  reason: Schema.Literals([
    "terminal",
    "cancelled",
    "already_claimed",
    "stale_dispatch",
    "pool_mismatch",
    "retry_wait"
  ]),
  retryAt: Schema.optionalKey(IsoDateTime)
})

export const AcquireAgentRunResult = Schema.Union([AcquiredAgentRun, AgentRunNotEligible])

export const RenewAgentRunLease = Schema.Struct({
  authority: AgentRunAttemptAuthority,
  leaseMs: PositiveInt
})

export const AppendAgentRunCheckpoint = Schema.Struct({
  authority: AgentRunAttemptAuthority,
  operation: AgentRunOperation
})

export const RecordAgentRunOutcome = Schema.Struct({
  authority: AgentRunAttemptAuthority,
  result: AgentRunResult
})

export const AgentRunControl = Schema.Struct({
  revision: NonNegativeInt,
  cancellationRequested: Schema.Boolean,
  reason: Schema.optionalKey(
    Schema.Literals(["owner_request", "superseded", "operator_drain", "policy"])
  )
})

export class AgentRunAuthorityLost extends Schema.TaggedError<AgentRunAuthorityLost>()(
  "AgentRunAuthorityLost",
  { runId: Uuid, attemptId: Uuid }
) {}
export class AgentRunCheckpointConflict extends Schema.TaggedError<AgentRunCheckpointConflict>()(
  "AgentRunCheckpointConflict",
  { runId: Uuid, sequence: PositiveInt }
) {}
export class AgentRunGatewayUnavailable extends Schema.TaggedError<AgentRunGatewayUnavailable>()(
  "AgentRunGatewayUnavailable",
  { operation: Schema.String, cause: Schema.Unknown }
) {}

export type AgentRunJob = typeof AgentRunJob.Type
export type AgentRunContinuationJob = typeof AgentRunContinuationJob.Type
export type AgentRunAttemptAuthority = typeof AgentRunAttemptAuthority.Type
export type AcquireAgentRun = typeof AcquireAgentRun.Type
export type AcquireAgentRunResult = typeof AcquireAgentRunResult.Type
export type RenewAgentRunLease = typeof RenewAgentRunLease.Type
export type AppendAgentRunCheckpoint = typeof AppendAgentRunCheckpoint.Type
export type RecordAgentRunOutcome = typeof RecordAgentRunOutcome.Type
export type AgentRunControl = typeof AgentRunControl.Type

export type AgentRunGatewayError = AgentRunAuthorityLost | AgentRunGatewayUnavailable

export interface AgentRunGatewayService {
  readonly acquire: (
    input: AcquireAgentRun
  ) => Effect.Effect<AcquireAgentRunResult, AgentRunGatewayUnavailable>
  readonly renew: (
    input: RenewAgentRunLease
  ) => Effect.Effect<AgentRunAttemptAuthority, AgentRunGatewayError>
  readonly appendCheckpoint: (
    input: AppendAgentRunCheckpoint
  ) => Effect.Effect<"appended" | "duplicate", AgentRunGatewayError | AgentRunCheckpointConflict>
  readonly readControl: (
    authority: AgentRunAttemptAuthority
  ) => Effect.Effect<AgentRunControl, AgentRunGatewayError>
  readonly recordOutcome: (
    input: RecordAgentRunOutcome
  ) => Effect.Effect<"accepted" | "duplicate", AgentRunGatewayError>
}

export class AgentRunGateway extends Context.Service<AgentRunGateway, AgentRunGatewayService>()(
  "@bob/application-agent-runs/AgentRunGateway"
) {}
