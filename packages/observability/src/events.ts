import { Schema } from "effect"

const OpaqueId = Schema.String.check(Schema.isUUID())
const Status = Schema.Literals(["started", "completed", "failed", "cancelled", "unknown"])

export const HealthEvent = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("webhook"),
    correlationId: OpaqueId,
    status: Schema.Literals(["accepted", "duplicate", "rejected", "failed"]),
    code: Schema.String,
    durationMs: Schema.Int
  }),
  Schema.Struct({
    type: Schema.Literal("agent_run"),
    correlationId: OpaqueId,
    runId: OpaqueId,
    status: Status,
    model: Schema.String,
    durationMs: Schema.Int,
    inputTokens: Schema.Int,
    outputTokens: Schema.Int
  }),
  Schema.Struct({
    type: Schema.Literal("tool_call"),
    correlationId: OpaqueId,
    runId: OpaqueId,
    toolCallId: Schema.String,
    toolName: Schema.String,
    status: Status,
    durationMs: Schema.Int
  }),
  Schema.Struct({
    type: Schema.Literal("delivery"),
    correlationId: OpaqueId,
    outboxId: OpaqueId,
    attemptId: OpaqueId,
    status: Schema.Literals(["accepted", "delivered", "failed", "uncertain"]),
    code: Schema.String,
    durationMs: Schema.Int
  }),
  Schema.Struct({
    type: Schema.Literal("reminder_clock"),
    correlationId: OpaqueId,
    ownerId: OpaqueId,
    status: Status,
    dueCount: Schema.Int,
    durationMs: Schema.Int
  }),
  Schema.Struct({
    type: Schema.Literal("provider_auth"),
    correlationId: OpaqueId,
    status: Schema.Literals(["configured", "missing", "failed"]),
    code: Schema.String
  })
])

export type HealthEvent = typeof HealthEvent.Type

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
    provider_auth: [...common, "code"]
  }
  const allowed = typeof type === "string" ? allowedByType[type] : undefined
  if (allowed === undefined || Object.keys(value).some((key) => !allowed.includes(key))) {
    throw new TypeError("Health event contains an unknown field")
  }

  return Schema.decodeUnknownSync(HealthEvent)(value)
}
