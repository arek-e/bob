import { ToolName } from "@bob/capabilities-types/tools"
import { OutputValidationCode } from "@bob/policy-types/output-safety"
import { Context, Effect, Exit, Layer, Option, Schema, Tracer } from "effect"

import {
  parseHealthEvent,
  TelemetryFeature,
  TelemetryWorkflow,
  type HealthEvent
} from "./events.ts"

export const BobSpanName = Schema.Literals([
  "bob.webhook.receive",
  "bob.inbound.invoke",
  "bob.inbound.attachment.store",
  "bob.inbound.accept",
  "bob.inbound.persist",
  "bob.inbound.publish",
  "bob.inbound.confirm",
  "bob.inbound.confirm_accept",
  "bob.inbound.consume",
  "bob.inbound.reconcile",
  "bob.coordinator.invoke",
  "bob.coordinator.run",
  "bob.turn.collect",
  "bob.turn.reflect",
  "bob.run.cancel_request",
  "bob.agent.abort",
  "bob.reply.commit",
  "bob.reply.suppress",
  "bob.inbound.process",
  "bob.inbound.claim",
  "bob.context.build",
  "bob.context.retrieve",
  "bob.agent_run.persist",
  "bob.agent.invoke",
  "bob.agent.run",
  "bob.agent.loop",
  "bob.agent.turn",
  "bob.model.complete",
  "bob.tool.invoke",
  "bob.tool.execute",
  "bob.tool.claim",
  "bob.tool.domain",
  "bob.output.validate",
  "bob.output.repair",
  "bob.agent_run.finish",
  "bob.outbox.create",
  "bob.outbox.publish",
  "bob.outbox.consume",
  "bob.outbox.invoke",
  "bob.outbox.claim",
  "bob.provider.send",
  "bob.provider.status",
  "bob.delivery_result.publish",
  "bob.delivery_result.invoke",
  "bob.delivery_result.consume",
  "bob.delivery_result.accept",
  "bob.delivery_result.record",
  "bob.scheduled.run",
  "bob.reminder.clock",
  "bob.reminder.invoke",
  "bob.reminder.accept",
  "bob.reminder.dispatch"
])

export type BobSpanName = typeof BobSpanName.Type

export const BobDecisionName = Schema.Literals([
  "bob.decision.route",
  "bob.decision.toolset",
  "bob.decision.loop",
  "bob.decision.tool_gate",
  "bob.decision.idempotency",
  "bob.decision.policy",
  "bob.decision.grounding",
  "bob.decision.output",
  "bob.decision.steering",
  "bob.state.transition"
])

export type BobDecisionName = typeof BobDecisionName.Type

export const BobDecisionCode = Schema.Literals([
  "allowed",
  "agent_turn",
  "arguments_invalid",
  "abort_model",
  "burst_append",
  "confirmation_required",
  "deterministic_command",
  "external_unknown",
  "final",
  "grounding_conflict",
  "grounding_missing",
  "grounding_not_required",
  "grounding_present",
  "in_progress",
  "invalid_output",
  "limit",
  "new",
  "not_allowlisted",
  "not_registered",
  "provider_control",
  "provider_failure",
  "restart_with_receipts",
  "reminder_intent",
  "repair_failed",
  "repair_required",
  "repair_succeeded",
  "replay",
  "timeout",
  "stale_reply_suppressed",
  "tool_calls",
  "training_safety",
  "turn_limit",
  "wait_effect",
  "urgent_safety",
  "valid_output"
])

export type BobDecisionCode = typeof BobDecisionCode.Type
export const BobDecisionOutcome = Schema.Literals([
  "allowed",
  "denied",
  "selected",
  "applied",
  "skipped"
])
export type BobDecisionOutcome = typeof BobDecisionOutcome.Type
export const BobTurnPhase = Schema.Literals(["primary", "repair"])
export type BobTurnPhase = typeof BobTurnPhase.Type

export interface SafeAttributes {
  [key: string]: string | number | boolean
}

export interface BobDecision {
  readonly name: BobDecisionName
  readonly code: BobDecisionCode
  readonly outcome: BobDecisionOutcome
  readonly selectedCount?: number
  readonly toolName?: string
  readonly validationCode?: typeof OutputValidationCode.Type
  readonly conversationRevision?: number
}

export interface BobSpan {
  readonly name: BobSpanName
  readonly correlationId: string
  readonly runId?: string
  readonly outboxId?: string
  readonly deliveryAttemptId?: string
  readonly reminderOccurrenceId?: string
  readonly conversationTurnId?: string
  readonly conversationRevision?: number
  readonly feature: TelemetryFeature
  readonly turnIndex?: number
  readonly turnPhase?: BobTurnPhase
  readonly toolName?: string
  readonly toolCallIndex?: number
}

export interface BobModelUsage {
  readonly provider: "openai-codex"
  readonly model: string
  readonly inputTokens: number
  readonly outputTokens: number
  readonly toolCallCount: number
}

export interface SafeSpanEvent {
  readonly name: BobDecisionName
  readonly timeUnixNano: bigint
  readonly attributes: Readonly<SafeAttributes>
}

export interface SafeSpanRecord {
  readonly name: BobSpanName
  readonly traceId: string
  readonly spanId: string
  readonly parentSpanId?: string
  readonly kind: Tracer.SpanKind
  readonly sampled: boolean
  readonly startTimeUnixNano: bigint
  readonly endTimeUnixNano: bigint
  readonly outcome: "completed" | "failed"
  readonly attributes: Readonly<SafeAttributes>
  readonly events: ReadonlyArray<SafeSpanEvent>
}

export interface Telemetry {
  readonly emitHealth: (event: HealthEvent) => Effect.Effect<void>
  readonly flush: Effect.Effect<void>
}

export const Telemetry = Context.Service<Telemetry>("bob/Telemetry")

export interface SafeSpanProcessor {
  onEnd(span: SafeSpanRecord): void
  readonly forceFlush: Effect.Effect<void>
  readonly shutdown: Effect.Effect<void>
}

export const noopSpanProcessor: SafeSpanProcessor = {
  onEnd: () => undefined,
  forceFlush: Effect.void,
  shutdown: Effect.void
}

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const safeModelPattern = /^gpt-[a-z0-9][a-z0-9.-]{0,90}$/

const spanSemantics = {
  "bob.webhook.receive": { kind: "server", workflow: "inbound_message" },
  "bob.inbound.invoke": { kind: "client", workflow: "inbound_message" },
  "bob.inbound.attachment.store": { kind: "client", workflow: "inbound_message" },
  "bob.inbound.accept": { kind: "server", workflow: "inbound_message" },
  "bob.inbound.persist": { kind: "internal", workflow: "inbound_message" },
  "bob.inbound.publish": { kind: "producer", workflow: "inbound_message" },
  "bob.inbound.confirm": { kind: "client", workflow: "inbound_message" },
  "bob.inbound.confirm_accept": { kind: "server", workflow: "inbound_message" },
  "bob.inbound.consume": { kind: "consumer", workflow: "inbound_message" },
  "bob.inbound.reconcile": { kind: "client", workflow: "inbound_message" },
  "bob.coordinator.invoke": { kind: "client", workflow: "inbound_message" },
  "bob.coordinator.run": { kind: "server", workflow: "inbound_message" },
  "bob.turn.collect": { kind: "internal", workflow: "inbound_message" },
  "bob.turn.reflect": { kind: "internal", workflow: "agent_turn" },
  "bob.run.cancel_request": { kind: "client", workflow: "agent_turn" },
  "bob.agent.abort": { kind: "server", workflow: "agent_turn" },
  "bob.reply.commit": { kind: "internal", workflow: "outbound_delivery" },
  "bob.reply.suppress": { kind: "internal", workflow: "outbound_delivery" },
  "bob.inbound.process": { kind: "internal", workflow: "inbound_message" },
  "bob.inbound.claim": { kind: "internal", workflow: "inbound_message" },
  "bob.context.build": { kind: "internal", workflow: "agent_turn" },
  "bob.context.retrieve": { kind: "internal", workflow: "agent_turn" },
  "bob.agent_run.persist": { kind: "internal", workflow: "agent_turn" },
  "bob.agent.invoke": { kind: "client", workflow: "agent_turn" },
  "bob.agent.run": { kind: "server", workflow: "agent_turn" },
  "bob.agent.loop": { kind: "internal", workflow: "agent_turn" },
  "bob.agent.turn": { kind: "internal", workflow: "agent_turn" },
  "bob.model.complete": { kind: "client", workflow: "agent_turn" },
  "bob.tool.invoke": { kind: "client", workflow: "tool_execution" },
  "bob.tool.execute": { kind: "server", workflow: "tool_execution" },
  "bob.tool.claim": { kind: "internal", workflow: "tool_execution" },
  "bob.tool.domain": { kind: "internal", workflow: "tool_execution" },
  "bob.output.validate": { kind: "internal", workflow: "agent_turn" },
  "bob.output.repair": { kind: "internal", workflow: "agent_turn" },
  "bob.agent_run.finish": { kind: "internal", workflow: "agent_turn" },
  "bob.outbox.create": { kind: "internal", workflow: "outbound_delivery" },
  "bob.outbox.publish": { kind: "producer", workflow: "outbound_delivery" },
  "bob.outbox.consume": { kind: "consumer", workflow: "outbound_delivery" },
  "bob.outbox.invoke": { kind: "client", workflow: "outbound_delivery" },
  "bob.outbox.claim": { kind: "server", workflow: "outbound_delivery" },
  "bob.provider.send": { kind: "client", workflow: "outbound_delivery" },
  "bob.provider.status": { kind: "server", workflow: "outbound_delivery" },
  "bob.delivery_result.publish": { kind: "producer", workflow: "outbound_delivery" },
  "bob.delivery_result.invoke": { kind: "client", workflow: "outbound_delivery" },
  "bob.delivery_result.consume": { kind: "consumer", workflow: "outbound_delivery" },
  "bob.delivery_result.accept": { kind: "server", workflow: "outbound_delivery" },
  "bob.delivery_result.record": { kind: "internal", workflow: "outbound_delivery" },
  "bob.scheduled.run": { kind: "internal", workflow: "scheduled_reconcile" },
  "bob.reminder.clock": { kind: "internal", workflow: "reminder_delivery" },
  "bob.reminder.invoke": { kind: "client", workflow: "reminder_delivery" },
  "bob.reminder.accept": { kind: "server", workflow: "reminder_delivery" },
  "bob.reminder.dispatch": { kind: "producer", workflow: "reminder_delivery" }
} satisfies Readonly<
  Record<BobSpanName, { readonly kind: Tracer.SpanKind; readonly workflow: TelemetryWorkflow }>
>

function assertNatural(value: number | undefined, label: string): void {
  if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
    throw new TypeError(`${label} must be a natural number`)
  }
}

function validateSpan(input: BobSpan): void {
  Schema.decodeUnknownSync(BobSpanName)(input.name)
  if (!uuidPattern.test(input.correlationId)) throw new TypeError("Correlation ID is invalid")
  if (input.runId !== undefined && !uuidPattern.test(input.runId)) {
    throw new TypeError("Run ID is invalid")
  }
  if (input.outboxId !== undefined && !uuidPattern.test(input.outboxId)) {
    throw new TypeError("Outbox ID is invalid")
  }
  if (input.deliveryAttemptId !== undefined && !uuidPattern.test(input.deliveryAttemptId)) {
    throw new TypeError("Delivery attempt ID is invalid")
  }
  if (input.reminderOccurrenceId !== undefined && !uuidPattern.test(input.reminderOccurrenceId)) {
    throw new TypeError("Reminder occurrence ID is invalid")
  }
  if (input.conversationTurnId !== undefined && !uuidPattern.test(input.conversationTurnId)) {
    throw new TypeError("Conversation turn ID is invalid")
  }
  assertNatural(input.conversationRevision, "Conversation revision")
  if (input.toolName !== undefined) {
    Schema.decodeUnknownSync(ToolName)(input.toolName)
  }
  assertNatural(input.turnIndex, "Turn index")
  assertNatural(input.toolCallIndex, "Tool-call index")
}

function validateDecision(input: BobDecision): void {
  Schema.decodeUnknownSync(BobDecisionName)(input.name)
  Schema.decodeUnknownSync(BobDecisionCode)(input.code)
  Schema.decodeUnknownSync(BobDecisionOutcome)(input.outcome)
  assertNatural(input.selectedCount, "Selected count")
  assertNatural(input.conversationRevision, "Conversation revision")
  if (input.toolName !== undefined) Schema.decodeUnknownSync(ToolName)(input.toolName)
  if (input.validationCode !== undefined) {
    if (input.name !== "bob.decision.output" || input.code !== "repair_required") {
      throw new TypeError("Output validation code requires a failed output-validation decision")
    }
    Schema.decodeUnknownSync(OutputValidationCode)(input.validationCode)
  }
}

function spanAttributes(input: BobSpan): SafeAttributes {
  const semantics = spanSemantics[input.name]
  const attributes: SafeAttributes = {
    "bob.correlation.id": input.correlationId,
    "bob.feature": input.feature,
    "bob.workflow": semantics.workflow
  }
  if (input.runId !== undefined) attributes["bob.run.id"] = input.runId
  if (input.outboxId !== undefined) attributes["bob.outbox.id"] = input.outboxId
  if (input.deliveryAttemptId !== undefined)
    attributes["bob.delivery.attempt_id"] = input.deliveryAttemptId
  if (input.reminderOccurrenceId !== undefined)
    attributes["bob.reminder.occurrence_id"] = input.reminderOccurrenceId
  if (input.conversationTurnId !== undefined)
    attributes["bob.conversation.turn_id"] = input.conversationTurnId
  if (input.conversationRevision !== undefined)
    attributes["bob.conversation.revision"] = input.conversationRevision
  if (input.turnIndex !== undefined) attributes["bob.turn.index"] = input.turnIndex
  if (input.turnPhase !== undefined) attributes["bob.turn.phase"] = input.turnPhase
  if (input.toolName !== undefined) attributes["bob.tool.name"] = input.toolName
  if (input.toolCallIndex !== undefined) attributes["bob.tool.call_index"] = input.toolCallIndex
  return attributes
}

function safeNatural<Value>(value: Value, maximum: number): value is Value & number {
  return Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= maximum
}

function safeString<Value>(value: Value, pattern: RegExp): value is Value & string {
  return Object.prototype.toString.call(value) === "[object String]" && pattern.test(String(value))
}

function safeSpanAttributes(
  name: BobSpanName,
  attributes: ReadonlyMap<string, unknown>
): Readonly<SafeAttributes> | undefined {
  const correlationId = attributes.get("bob.correlation.id")
  if (!safeString(correlationId, uuidPattern)) return undefined
  const output: SafeAttributes = {
    "bob.correlation.id": correlationId
  }
  const feature = attributes.get("bob.feature")
  const workflow = attributes.get("bob.workflow")
  try {
    output["bob.feature"] = Schema.decodeUnknownSync(TelemetryFeature)(feature)
    const decodedWorkflow = Schema.decodeUnknownSync(TelemetryWorkflow)(workflow)
    if (decodedWorkflow !== spanSemantics[name].workflow) return undefined
    output["bob.workflow"] = decodedWorkflow
  } catch {
    return undefined
  }
  const runId = attributes.get("bob.run.id")
  if (safeString(runId, uuidPattern)) output["bob.run.id"] = runId
  const outboxId = attributes.get("bob.outbox.id")
  if (safeString(outboxId, uuidPattern)) {
    output["bob.outbox.id"] = outboxId
  }
  const deliveryAttemptId = attributes.get("bob.delivery.attempt_id")
  if (safeString(deliveryAttemptId, uuidPattern)) {
    output["bob.delivery.attempt_id"] = deliveryAttemptId
  }
  const reminderOccurrenceId = attributes.get("bob.reminder.occurrence_id")
  if (safeString(reminderOccurrenceId, uuidPattern)) {
    output["bob.reminder.occurrence_id"] = reminderOccurrenceId
  }
  const conversationTurnId = attributes.get("bob.conversation.turn_id")
  if (safeString(conversationTurnId, uuidPattern)) {
    output["bob.conversation.turn_id"] = conversationTurnId
  }
  const conversationRevision = attributes.get("bob.conversation.revision")
  if (safeNatural(conversationRevision, 10_000)) {
    output["bob.conversation.revision"] = conversationRevision
  }
  const turnIndex = attributes.get("bob.turn.index")
  if (safeNatural(turnIndex, 64)) output["bob.turn.index"] = turnIndex
  const turnPhase = attributes.get("bob.turn.phase")
  try {
    output["bob.turn.phase"] = Schema.decodeUnknownSync(BobTurnPhase)(turnPhase)
  } catch {
    // Unknown turn phases can contain user content. Drop the field.
  }
  const toolName = attributes.get("bob.tool.name")
  if (Object.prototype.toString.call(toolName) === "[object String]") {
    try {
      output["bob.tool.name"] = Schema.decodeUnknownSync(ToolName)(toolName)
    } catch {
      // Unknown Tool names can contain user content. Drop the field.
    }
  }
  const toolCallIndex = attributes.get("bob.tool.call_index")
  if (safeNatural(toolCallIndex, 100)) output["bob.tool.call_index"] = toolCallIndex
  const provider = attributes.get("gen_ai.provider.name")
  if (provider === "openai-codex") output["gen_ai.provider.name"] = provider
  const model = attributes.get("gen_ai.request.model")
  if (safeString(model, safeModelPattern)) {
    output["gen_ai.request.model"] = model
  }
  const inputTokens = attributes.get("gen_ai.usage.input_tokens")
  if (safeNatural(inputTokens, 10_000_000)) {
    output["gen_ai.usage.input_tokens"] = inputTokens
  }
  const outputTokens = attributes.get("gen_ai.usage.output_tokens")
  if (safeNatural(outputTokens, 10_000_000)) {
    output["gen_ai.usage.output_tokens"] = outputTokens
  }
  const toolCallCount = attributes.get("bob.tool.call_count")
  if (safeNatural(toolCallCount, 100)) output["bob.tool.call_count"] = toolCallCount
  return output
}

function safeDecisionEvent(event: Tracer.NativeSpan["events"][number]): SafeSpanEvent | undefined {
  let name: BobDecisionName
  let code: BobDecisionCode
  try {
    name = Schema.decodeUnknownSync(BobDecisionName)(event[0])
    code = Schema.decodeUnknownSync(BobDecisionCode)(event[2]["bob.decision.code"])
  } catch {
    return undefined
  }
  let outcome: BobDecisionOutcome
  try {
    outcome = Schema.decodeUnknownSync(BobDecisionOutcome)(event[2]["bob.decision.outcome"])
  } catch {
    return undefined
  }
  const selectedCount = event[2]["bob.selected.count"]
  const toolName = event[2]["bob.tool.name"]
  const validationCode = event[2]["bob.output.validation_code"]
  const conversationRevision = event[2]["bob.conversation.revision"]
  let safeToolName: string | undefined
  if (Object.prototype.toString.call(toolName) === "[object String]") {
    try {
      safeToolName = Schema.decodeUnknownSync(ToolName)(toolName)
    } catch {
      // Unknown Tool names can contain user content. Drop the field.
    }
  }
  let safeValidationCode: typeof OutputValidationCode.Type | undefined
  if (
    name === "bob.decision.output" &&
    code === "repair_required" &&
    Object.prototype.toString.call(validationCode) === "[object String]"
  ) {
    try {
      safeValidationCode = Schema.decodeUnknownSync(OutputValidationCode)(validationCode)
    } catch {
      // Unknown values can contain user content. Drop the field.
    }
  }
  const attributes: SafeAttributes = {
    "bob.decision.code": code,
    "bob.decision.outcome": outcome
  }
  if (safeNatural(selectedCount, 100)) attributes["bob.selected.count"] = selectedCount
  if (safeToolName !== undefined) attributes["bob.tool.name"] = safeToolName
  if (safeValidationCode !== undefined)
    attributes["bob.output.validation_code"] = safeValidationCode
  if (safeNatural(conversationRevision, 10_000))
    attributes["bob.conversation.revision"] = conversationRevision
  return {
    name,
    timeUnixNano: event[1],
    attributes
  }
}

function toSafeSpanRecord(
  span: Tracer.NativeSpan,
  endTimeUnixNano: bigint,
  exit: Exit.Exit<unknown, unknown>
): SafeSpanRecord | undefined {
  let name: BobSpanName
  try {
    name = Schema.decodeUnknownSync(BobSpanName)(span.name)
  } catch {
    return undefined
  }
  const attributes = safeSpanAttributes(name, span.attributes)
  if (attributes === undefined) return undefined
  const parent = Option.getOrUndefined(span.parent)
  const output = {
    name,
    traceId: span.traceId,
    spanId: span.spanId,
    kind: spanSemantics[name].kind,
    sampled: span.sampled,
    startTimeUnixNano: span.startTime,
    endTimeUnixNano,
    outcome: spanOutcome(exit),
    attributes,
    events: span.events.flatMap((event) => {
      const safe = safeDecisionEvent(event)
      return safe === undefined ? [] : [safe]
    })
  }
  return parent === undefined ? output : { ...output, parentSpanId: parent.spanId }
}

export function makeSafeTracer(processor: SafeSpanProcessor): Tracer.Tracer {
  return Tracer.make({
    span(input) {
      return new (class extends Tracer.NativeSpan {
        override end(endTime: bigint, exit: Parameters<Tracer.Span["end"]>[1]): void {
          super.end(endTime, exit)
          const safe = toSafeSpanRecord(this, endTime, exit)
          if (safe !== undefined && safe.sampled) {
            try {
              processor.onEnd(safe)
            } catch {
              // Telemetry must not change the application result.
            }
          }
        }
      })(input)
    }
  })
}

export function telemetryLayer(options: {
  readonly processor: SafeSpanProcessor
  readonly writeHealth?: (event: HealthEvent) => void
}): Layer.Layer<Telemetry> {
  const writeHealth =
    options.writeHealth ?? ((event: HealthEvent) => console.log(JSON.stringify(event)))
  const safeFlush = options.processor.forceFlush.pipe(Effect.catchCause(() => Effect.void))
  const safeShutdown = options.processor.shutdown.pipe(Effect.catchCause(() => Effect.void))
  const service = Effect.acquireRelease(
    Effect.succeed<Telemetry>({
      emitHealth: (event) =>
        Effect.sync(() => writeHealth(parseHealthEvent(event))).pipe(
          Effect.catchCause(() => Effect.void)
        ),
      flush: safeFlush
    }),
    () => safeShutdown
  )
  return Layer.merge(
    Layer.succeed(Tracer.Tracer, makeSafeTracer(options.processor)),
    Layer.effect(Telemetry, service)
  )
}

/** A fail-open telemetry Layer for local tests and disabled exporters. */
export const noopTelemetryLayer: Layer.Layer<Telemetry> = telemetryLayer({
  processor: noopSpanProcessor,
  writeHealth: () => undefined
})

function withBobSpanOptions<A, E, R>(
  input: BobSpan,
  effect: Effect.Effect<A, E, R>,
  root: boolean
): Effect.Effect<A, E, Exclude<R, Tracer.ParentSpan>> {
  try {
    validateSpan(input)
  } catch {
    const invalidOptions = {
      kind: "internal",
      sampled: false,
      captureStackTrace: false
    } satisfies Tracer.SpanOptions
    return Effect.withSpan(
      effect,
      "bob.telemetry.invalid",
      root ? { ...invalidOptions, root: true } : invalidOptions
    )
  }
  const semantics = spanSemantics[input.name]
  const options = {
    kind: semantics.kind,
    attributes: spanAttributes(input),
    captureStackTrace: false
  }
  return Effect.withSpan(effect, input.name, root ? { ...options, root: true } : options)
}

export function withBobSpan<A, E, R>(
  input: BobSpan,
  effect: Effect.Effect<A, E, R>
): Effect.Effect<A, E, Exclude<R, Tracer.ParentSpan>> {
  return withBobSpanOptions(input, effect, false)
}

export function withBobRootSpan<A, E, R>(
  input: BobSpan,
  effect: Effect.Effect<A, E, R>
): Effect.Effect<A, E, Exclude<R, Tracer.ParentSpan>> {
  return withBobSpanOptions(input, effect, true)
}

export function recordDecision(input: BobDecision): Effect.Effect<void> {
  try {
    validateDecision(input)
  } catch {
    return Effect.void
  }
  return Effect.gen(function* () {
    const span = yield* Effect.currentSpan
    const now = yield* Effect.clockWith((clock) => clock.currentTimeNanos)
    const attributes: SafeAttributes = {
      "bob.decision.code": input.code,
      "bob.decision.outcome": input.outcome
    }
    if (input.selectedCount !== undefined) attributes["bob.selected.count"] = input.selectedCount
    if (input.toolName !== undefined) attributes["bob.tool.name"] = input.toolName
    if (input.validationCode !== undefined)
      attributes["bob.output.validation_code"] = input.validationCode
    if (input.conversationRevision !== undefined)
      attributes["bob.conversation.revision"] = input.conversationRevision
    span.event(input.name, now, attributes)
  }).pipe(Effect.catchTag("NoSuchElementError", () => Effect.void))
}

export function annotateModelUsage(input: BobModelUsage): Effect.Effect<void> {
  const attributes: Record<string, string | number> = {}
  if (input.provider === "openai-codex") {
    attributes["gen_ai.provider.name"] = input.provider
  }
  if (safeModelPattern.test(input.model)) {
    attributes["gen_ai.request.model"] = input.model
  }
  if (safeNatural(input.inputTokens, 10_000_000)) {
    attributes["gen_ai.usage.input_tokens"] = input.inputTokens
  }
  if (safeNatural(input.outputTokens, 10_000_000)) {
    attributes["gen_ai.usage.output_tokens"] = input.outputTokens
  }
  if (safeNatural(input.toolCallCount, 100)) {
    attributes["bob.tool.call_count"] = input.toolCallCount
  }
  return Object.keys(attributes).length === 0 ? Effect.void : Effect.annotateCurrentSpan(attributes)
}

export const flushTelemetry: Effect.Effect<void, never, Telemetry> = Effect.gen(function* () {
  const telemetry = yield* Telemetry
  yield* telemetry.flush
})

export function emitHealth(event: HealthEvent): Effect.Effect<void, never, Telemetry> {
  return Telemetry.use((telemetry) => telemetry.emitHealth(event))
}

export const currentBobCorrelationId: Effect.Effect<string | undefined> = Effect.currentSpan.pipe(
  Effect.map((span) => {
    const value = span.attributes.get("bob.correlation.id")
    return safeString(value, uuidPattern) ? value : undefined
  }),
  Effect.catchTag("NoSuchElementError", () => Effect.succeed(undefined))
)

export function spanOutcome(exit: Exit.Exit<unknown, unknown>): "completed" | "failed" {
  return Exit.isSuccess(exit) ? "completed" : "failed"
}
