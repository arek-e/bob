import { ToolName } from "@bob/core-capabilities-types/tools"
import { Schema } from "effect"

const OpaqueId = Schema.String.check(Schema.isUUID())
const Status = Schema.Literals(["started", "completed", "failed", "cancelled", "unknown"])
const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
const ModelName = Schema.String.check(Schema.isPattern(/^gpt-[a-z0-9][a-z0-9.-]{0,90}$/))
const WebhookCode = Schema.Literals([
  "accepted",
  "duplicate",
  "durable_store_failed",
  "queue_publish_failed",
  "enqueue_record_failed",
  "unknown"
])
const DeliveryCode = Schema.Union([
  Schema.Literals(["accepted", "invalid_success_response", "timeout", "network"]),
  Schema.String.check(Schema.isPattern(/^http_[1-5][0-9]{2}$/))
])

export const TelemetryFeature = Schema.String.check(
  Schema.isPattern(/^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/),
  Schema.isMaxLength(64)
)

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
    code: WebhookCode,
    durationMs: NonNegativeInt
  }),
  Schema.Struct({
    type: Schema.Literal("agent_run"),
    correlationId: OpaqueId,
    runId: OpaqueId,
    status: Status,
    model: ModelName,
    durationMs: NonNegativeInt,
    inputTokens: NonNegativeInt,
    outputTokens: NonNegativeInt
  }),
  Schema.Struct({
    type: Schema.Literal("tool_call"),
    correlationId: OpaqueId,
    runId: OpaqueId,
    toolName: ToolName,
    status: Status,
    durationMs: NonNegativeInt
  }),
  Schema.Struct({
    type: Schema.Literal("delivery"),
    correlationId: OpaqueId,
    outboxId: OpaqueId,
    attemptId: OpaqueId,
    status: Schema.Literals(["accepted", "delivered", "failed", "uncertain"]),
    code: DeliveryCode,
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
    code: Schema.Literals(["configured", "missing", "failed"])
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
    model: ModelName,
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

/** Validate and emit one read-only event without changing application control flow. */
export async function observeHealth(sink: EventSink, event: HealthEvent): Promise<void> {
  try {
    await sink.emit(parseHealthEvent(event))
  } catch {
    // Observation cannot change the result of the observed workflow.
  }
}

export function parseHealthEvent<Input>(value: Input): HealthEvent {
  const input = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Json))(value)
  const event = Schema.decodeUnknownSync(HealthEvent)(input)
  const common = ["type", "correlationId", "status"]
  const allowedByType = {
    webhook: [...common, "code", "durationMs"],
    agent_run: [...common, "runId", "model", "durationMs", "inputTokens", "outputTokens"],
    tool_call: [...common, "runId", "toolName", "durationMs"],
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
  } as const
  const allowed = new Set<string>(allowedByType[event.type])
  if (Object.keys(input).some((key) => !allowed.has(key))) {
    throw new TypeError("Health event contains an unknown field")
  }

  return event
}
