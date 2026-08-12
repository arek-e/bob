# ADR 0008: Use Effect telemetry Layers and one trace contract

- Status: Accepted
- Date: 2026-08-11
- Scope: Application tracing, telemetry privacy, and OTLP export

## Context

Bob needs one trace across Sendblue, Cloudflare, Pi, tools, reminders, and delivery.

The trace must show agent decisions without storing private content or model reasoning.

Node and Cloudflare use different runtimes.

The telemetry API must work in both runtimes.

Telemetry failures must never change a durable workflow result.

## Decision

Use `@bob/observability` as Bob's only application telemetry package.

Use core Effect tracing for the portable contract.

Keep Node and Cloudflare exporters behind explicit package exports.

Use these exports:

- `@bob/observability/effect` for span names, safe attributes, events, and the `Telemetry` service.
- `@bob/observability/propagation` for W3C `traceparent` parsing and injection.
- `@bob/observability/otlp` for bounded OTLP serialization and HTTP batching.
- `@bob/observability/node` for the process-scoped Node Layer.
- `@bob/observability/cloudflare` for invocation-scoped Worker Layers.
- `@bob/observability/testing` for deterministic capture Layers.

Do not add another application telemetry package.

### Layer lifetime

Create one managed telemetry runtime for each Node process.

Flush that runtime during controlled process shutdown.

Create one telemetry Layer for each Worker invocation.

Use `ExecutionContext.waitUntil` for the final Worker flush.

Do not create a Node telemetry runtime for each request.

Do not retain Worker processors across unrelated requests.

### Trace propagation

Use W3C `traceparent` at every HTTP and Queue boundary.

Treat incoming trace data as untrusted input.

Validate it before creating an external parent span.

Keep one workflow correlation identifier beside the trace context.

Do not use a provider webhook identifier as the workflow correlation identifier.

Keep producer, consumer, client, and server spans distinct.

### Agent trace

Create one `bob.agent.run` server span in the private agent host.

Run the complete Pi loop as one Effect program below that span.

Create one `bob.agent.turn` span for each primary or repair turn.

Create one `bob.model.complete` span for each model request.

Create one `bob.tool.invoke` client span for each Pi tool request.

Create one `bob.tool.execute` server span in Core.

Record output validation and repair as separate spans.

Attach `bob.output.validation_code` to a failed output-validation decision. Use only the
shared, closed `OutputValidationCode` values. Do not attach response text or schema errors.

Record decisions with stable codes only.

Never export chain-of-thought or natural-language reasoning.

### Privacy contract

Use a closed list of span names, decision names, decision codes, and attributes.

Validate every Tool name against the shared Tool contract.

Export identifiers only when they match their declared safe format.

Export token counts, durations, states, and stable result codes.

Do not export these values:

- prompts, replies, journal text, reminder text, or memory text;
- Tool arguments, Tool results, model reasoning, or provider bodies;
- phone numbers, addresses, URLs, query strings, headers, or cookies;
- access tokens, refresh tokens, passwords, secrets, or key material;
- raw error messages, stack traces, schema errors, or thrown causes.

This rule controls Bob's OTLP payloads and JSON events.

Cloudflare platform telemetry can retain request metadata before Bob handles a request.

Provider callback queries can contain only validated opaque workflow IDs and W3C trace data.

Never put user text, phone numbers, credentials, or provider bodies in a callback URL.

Inspect one live callback record before you accept production privacy proof.

Map expected denials and duplicates to successful spans with stable outcome codes.

Use error status only for unexpected, transport, storage, timeout, or provider failures.

### Export behavior

Use OTLP over HTTP with JSON payloads.

Bound queue size, batch size, request time, and shutdown time.

Drop new spans when the local telemetry queue is full.

Do not block a durable action on telemetry delivery.

Do not retry telemetry inside an application workflow.

Use separate service names for Core, agent, ingress, and egress.

Add the production release SHA and environment as resource attributes.

Use a separate Cloudflare Access service token for Worker OTLP export.

Do not reuse application service tokens or the Cloudflare deployment token.

### Effect and OpenTelemetry boundary

Workers import core Effect only.

Workers use the shared native `fetch` OTLP processor.

Node uses the same safe span processor contract.

Do not export Effect failure causes through the standard bridge.

Effect can include error text, stack data, and log events in native spans.

Bob's safe processor reads approved data only.

## Verification

Tests must prove the exact parent tree for the main workflows.

Tests must cover two concurrent traces without context exchange.

Tests must cover exporter timeout, rejection, queue overflow, and shutdown.

Tests must place private canary values in every unsafe input location.

No canary value can appear in spans, events, logs, or OTLP payloads.

Production acceptance needs one safe Sendblue request.

The request must appear in Tempo, Loki, and the durable D1 timeline.

Production proof stays incomplete until that acceptance test passes.

## Consequences

Bob gets one reusable telemetry seam across all runtimes.

The agent loop becomes visible without exposing private content.

Closed schemas limit arbitrary troubleshooting data.

New span attributes require a reviewed contract change.

Telemetry remains best-effort and cannot serve as the durable audit log.

D1 remains the authority for workflow state and user-visible history.
