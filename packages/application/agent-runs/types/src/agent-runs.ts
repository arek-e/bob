import { AgentRunRequest } from "@bob/agent-types/run"
import { IsoDateTime, Uuid } from "@bob/shared-types/shared"
import { Context, Effect, Schema } from "effect"

const PositiveInt = Schema.Int.check(Schema.isGreaterThan(0))
const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
const Identifier = Schema.String.check(
  Schema.isPattern(/^[a-z][a-z0-9-]{0,62}$/),
  Schema.isMaxLength(63)
)

export const AgentRunState = Schema.Literals([
  "accepted",
  "queued",
  "running",
  "retry_wait",
  "waiting_effect",
  "awaiting_finalization",
  "completed",
  "failed",
  "cancelled",
  "superseded",
  "indeterminate"
])

export const AgentRunTerminalOutcome = Schema.Literals([
  "completed",
  "failed",
  "cancelled",
  "superseded",
  "indeterminate"
])

export const AgentRunExecutionClass = Schema.Struct({
  jobProtocolVersion: PositiveInt,
  coreGatewayProtocolVersion: PositiveInt,
  checkpointLoopVersion: PositiveInt,
  deploymentProfileId: Identifier,
  capabilityCatalogueGeneration: Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(128)
  ),
  executionPoolId: Identifier
})

export const AgentRunOrigin = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("conversation_turn"),
    turnId: Uuid,
    revision: PositiveInt
  }),
  Schema.Struct({
    type: Schema.Literal("scheduled"),
    occurrenceId: Uuid
  }),
  Schema.Struct({
    type: Schema.Literal("proactive"),
    signalId: Uuid
  })
])

export const SubmitAgentRun = Schema.Struct({
  idempotencyKey: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
  origin: AgentRunOrigin,
  request: AgentRunRequest,
  execution: AgentRunExecutionClass
}).check(
  Schema.makeFilter((input) =>
    input.execution.deploymentProfileId === input.request.deploymentProfileId &&
    input.execution.capabilityCatalogueGeneration === input.request.capabilityCatalogueGeneration
      ? undefined
      : { path: ["execution"], issue: "execution class does not match the immutable request" }
  )
)

export const AgentRunReference = Schema.Struct({
  runId: Uuid,
  state: Schema.Literals(["accepted", "already_accepted"]),
  acceptedAt: IsoDateTime
})

export const CancelAgentRun = Schema.Struct({
  runId: Uuid,
  ownerId: Uuid,
  idempotencyKey: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
  reason: Schema.Literals(["owner_request", "superseded", "operator_drain", "policy"])
})

export const CancelAgentRunResult = Schema.Struct({
  state: Schema.Literals(["requested", "cancelled_before_start", "already_terminal"]),
  controlRevision: PositiveInt
})

export const InspectAgentRun = Schema.Struct({ runId: Uuid, ownerId: Uuid })

export const AgentRunView = Schema.Struct({
  runId: Uuid,
  ownerId: Uuid,
  state: AgentRunState,
  outcome: Schema.optionalKey(AgentRunTerminalOutcome),
  attemptCount: NonNegativeInt,
  executionPoolId: Identifier,
  submittedAt: IsoDateTime,
  startedAt: Schema.optionalKey(IsoDateTime),
  completedAt: Schema.optionalKey(IsoDateTime)
})

export class AgentRunInvalid extends Schema.TaggedError<AgentRunInvalid>()("AgentRunInvalid", {
  cause: Schema.Unknown
}) {}
export class AgentRunConflict extends Schema.TaggedError<AgentRunConflict>()("AgentRunConflict", {
  runId: Uuid
}) {}
export class AgentRunAdmissionRejected extends Schema.TaggedError<AgentRunAdmissionRejected>()(
  "AgentRunAdmissionRejected",
  { reason: Schema.Literals(["owner_limit", "cluster_limit", "quota", "pool_unavailable"]) }
) {}
export class AgentRunNotFound extends Schema.TaggedError<AgentRunNotFound>()(
  "AgentRunNotFound",
  {}
) {}
export class AgentRunsUnavailable extends Schema.TaggedError<AgentRunsUnavailable>()(
  "AgentRunsUnavailable",
  { operation: Schema.String, cause: Schema.Unknown }
) {}

export type AgentRunState = typeof AgentRunState.Type
export type AgentRunTerminalOutcome = typeof AgentRunTerminalOutcome.Type
export type AgentRunExecutionClass = typeof AgentRunExecutionClass.Type
export type AgentRunOrigin = typeof AgentRunOrigin.Type
export type SubmitAgentRun = typeof SubmitAgentRun.Type
export type AgentRunReference = typeof AgentRunReference.Type
export type CancelAgentRun = typeof CancelAgentRun.Type
export type CancelAgentRunResult = typeof CancelAgentRunResult.Type
export type InspectAgentRun = typeof InspectAgentRun.Type
export type AgentRunView = typeof AgentRunView.Type

export type AgentRunSubmitError =
  | AgentRunInvalid
  | AgentRunConflict
  | AgentRunAdmissionRejected
  | AgentRunsUnavailable
export type AgentRunCommandError = AgentRunNotFound | AgentRunsUnavailable
export type AgentRunInspectError = AgentRunNotFound | AgentRunsUnavailable

export interface AgentRunsService {
  readonly submit: (input: SubmitAgentRun) => Effect.Effect<AgentRunReference, AgentRunSubmitError>
  readonly cancel: (
    input: CancelAgentRun
  ) => Effect.Effect<CancelAgentRunResult, AgentRunCommandError>
  readonly inspect: (input: InspectAgentRun) => Effect.Effect<AgentRunView, AgentRunInspectError>
}

export class AgentRuns extends Context.Service<AgentRuns, AgentRunsService>()(
  "@bob/application-agent-runs/AgentRuns"
) {}
