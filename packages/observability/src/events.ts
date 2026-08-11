import { Schema } from "effect"

const OpaqueId = Schema.String.check(Schema.isUUID())
const Status = Schema.Literals(["started", "completed", "failed", "cancelled", "unknown"])
const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))

export const TelemetryFeature = Schema.Literals([
  "assistant",
  "reminders",
  "memory",
  "journal",
  "training",
  "settings",
  "safety",
  "delivery",
  "mixed"
])

export const TelemetryWorkflow = Schema.Literals([
  "inbound_message",
  "agent_turn",
  "tool_execution",
  "outbound_delivery",
  "reminder_delivery",
  "scheduled_reconcile",
  "administration"
])

export const WorkflowSpanName = Schema.Literals([
  "inbound.accept",
  "inbound.process",
  "context.build",
  "model.run",
  "tool.execute",
  "outbox.create",
  "outbox.publish",
  "provider.send",
  "provider.status"
])

const TraceId = Schema.String.check(Schema.isPattern(/^[0-9a-f]{32}$/))
const SpanId = Schema.String.check(Schema.isPattern(/^[0-9a-f]{16}$/))
export const TelemetrySpanCode = Schema.Literals([
  "ok",
  "unknown",
  "provider",
  "network",
  "authentication",
  "quota",
  "timeout",
  "cancelled",
  "policy",
  "invalid_output",
  "core_request",
  "durable_store",
  "queue_publish",
  "retrieval",
  "tool_execution"
])

export const HealthEvent = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("webhook"),
    correlationId: OpaqueId,
    status: Schema.Literals(["accepted", "duplicate", "rejected", "failed"]),
    code: Schema.String,
    durationMs: NonNegativeInt
  }),
  Schema.Struct({
    type: Schema.Literal("agent_run"),
    correlationId: OpaqueId,
    runId: OpaqueId,
    status: Status,
    model: Schema.String,
    durationMs: NonNegativeInt,
    inputTokens: NonNegativeInt,
    outputTokens: NonNegativeInt
  }),
  Schema.Struct({
    type: Schema.Literal("tool_call"),
    correlationId: OpaqueId,
    runId: OpaqueId,
    toolCallId: Schema.String,
    toolName: Schema.String,
    status: Status,
    durationMs: NonNegativeInt
  }),
  Schema.Struct({
    type: Schema.Literal("delivery"),
    correlationId: OpaqueId,
    outboxId: OpaqueId,
    attemptId: OpaqueId,
    status: Schema.Literals(["accepted", "delivered", "failed", "uncertain"]),
    code: Schema.String,
    durationMs: NonNegativeInt
  }),
  Schema.Struct({
    type: Schema.Literal("reminder_clock"),
    correlationId: OpaqueId,
    ownerId: OpaqueId,
    status: Status,
    dueCount: NonNegativeInt,
    durationMs: NonNegativeInt
  }),
  Schema.Struct({
    type: Schema.Literal("provider_auth"),
    correlationId: OpaqueId,
    status: Schema.Literals(["configured", "missing", "failed"]),
    code: Schema.String
  }),
  Schema.Struct({
    type: Schema.Literal("workflow_span"),
    correlationId: OpaqueId,
    traceId: TraceId,
    spanId: SpanId,
    parentSpanId: Schema.optionalKey(SpanId),
    name: WorkflowSpanName,
    feature: TelemetryFeature,
    workflow: TelemetryWorkflow,
    status: Schema.Literals(["completed", "failed"]),
    code: TelemetrySpanCode,
    durationMs: NonNegativeInt
  }),
  Schema.Struct({
    type: Schema.Literal("token_usage"),
    correlationId: OpaqueId,
    runId: OpaqueId,
    feature: TelemetryFeature,
    workflow: TelemetryWorkflow,
    provider: Schema.Literal("openai-codex"),
    model: Schema.String,
    status: Schema.Literals(["completed", "failed", "cancelled"]),
    inputTokens: NonNegativeInt,
    outputTokens: NonNegativeInt,
    toolCalls: NonNegativeInt,
    durationMs: NonNegativeInt
  }),
  Schema.Struct({
    type: Schema.Literal("retrieval"),
    correlationId: OpaqueId,
    runId: OpaqueId,
    feature: TelemetryFeature,
    workflow: Schema.Literal("agent_turn"),
    strategy: Schema.Literals(["confirmed_facts", "fts", "hybrid"]),
    status: Schema.Literals(["completed", "failed"]),
    selectedCount: NonNegativeInt,
    sourceCount: NonNegativeInt,
    conflictCount: NonNegativeInt,
    durationMs: NonNegativeInt
  }),
  Schema.Struct({
    type: Schema.Literal("token_budget"),
    correlationId: OpaqueId,
    runId: OpaqueId,
    feature: TelemetryFeature,
    workflow: Schema.Literal("agent_turn"),
    window: Schema.Literals(["run", "utc_day"]),
    windowKey: Schema.String.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}$|^run$/)),
    state: Schema.Literals(["within", "warning", "exceeded"]),
    consumedTokens: NonNegativeInt,
    budgetTokens: Schema.Int.check(Schema.isGreaterThan(0))
  })
])

export type HealthEvent = typeof HealthEvent.Type
export type TelemetryFeature = typeof TelemetryFeature.Type
export type TelemetryWorkflow = typeof TelemetryWorkflow.Type
export type WorkflowSpanName = typeof WorkflowSpanName.Type
export type TelemetrySpanCode = typeof TelemetrySpanCode.Type

export interface EventSink {
  emit(event: HealthEvent): void | Promise<void>
}

export function parseHealthEvent(value: unknown): HealthEvent {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Health event must be an object")
  }

  const type = Reflect.get(value, "type")
  const common = ["type", "correlationId", "status"]
  const allowedByType: Readonly<Record<string, readonly string[]>> = {
    webhook: [...common, "code", "durationMs"],
    agent_run: [...common, "runId", "model", "durationMs", "inputTokens", "outputTokens"],
    tool_call: [...common, "runId", "toolCallId", "toolName", "durationMs"],
    delivery: [...common, "outboxId", "attemptId", "code", "durationMs"],
    reminder_clock: [...common, "ownerId", "dueCount", "durationMs"],
    provider_auth: [...common, "code"],
    workflow_span: [
      ...common,
      "traceId",
      "spanId",
      "parentSpanId",
      "name",
      "feature",
      "workflow",
      "code",
      "durationMs"
    ],
    token_usage: [
      ...common,
      "runId",
      "feature",
      "workflow",
      "provider",
      "model",
      "inputTokens",
      "outputTokens",
      "toolCalls",
      "durationMs"
    ],
    retrieval: [
      ...common,
      "runId",
      "feature",
      "workflow",
      "strategy",
      "selectedCount",
      "sourceCount",
      "conflictCount",
      "durationMs"
    ],
    token_budget: [
      "type",
      "correlationId",
      "runId",
      "feature",
      "workflow",
      "window",
      "windowKey",
      "state",
      "consumedTokens",
      "budgetTokens"
    ]
  }
  const allowed = typeof type === "string" ? allowedByType[type] : undefined
  if (allowed === undefined || Object.keys(value).some((key) => !allowed.includes(key))) {
    throw new TypeError("Health event contains an unknown field")
  }

  return Schema.decodeUnknownSync(HealthEvent)(value)
}
