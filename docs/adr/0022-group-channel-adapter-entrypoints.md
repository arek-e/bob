# ADR 0022: Group Sendblue entrypoints in one app

- Status: Accepted
- Date: 2026-08-16
- Scope: Application workspaces and Sendblue deployment entrypoints
- Amends: ADR 0003

## Context

The Cloudflare Channel Runtime Adapter uses two Sendblue Workers.

The ingress Worker accepts public webhooks. It has no outbound provider credential.

The egress Worker sends messages and reconciles provider history. It owns the outbound provider credential.

The portable Channel Runtime reuses the same Sendblue modules in one Node process.

All entrypoints implement one selected Channel Adapter. Separate top-level workspaces made them look like two product apps.

The `apps` directory must identify deployed product units. It must not expose internal privilege zones as separate products.

## Decision

Use one `apps/sendblue-channel` workspace for the Sendblue Channel Adapter.

Keep separate ingress and egress Worker entrypoints for the Cloudflare Adapter.

Deploy both entrypoints as separate Cloudflare Worker resources.

Export the same ingress and egress modules to the portable Channel Runtime.

Each entrypoint owns its composition, bindings, environment schema, and build output.

Do not share a union binding type between the entrypoints.

Keep outbound Sendblue credentials out of the ingress Worker.

Keep the Cloudflare Job Queue, Scheduler, service-binding, domain, and recovery topology.

Keep the portable Runtime topology from ADR 0021.

An app workspace can contain multiple deployed entrypoints when they implement one product unit.

Each extra entrypoint must have a runtime or privilege boundary. Repository grouping does not weaken that boundary.

## Consequences

The repository shows one Sendblue app instead of two provider implementation details.

The Cloudflare deployment still creates two Workers. A compromised ingress Worker cannot send through the provider API.

The portable deployment keeps one Channel Runtime process. Its Adapter does not claim Cloudflare privilege isolation.

The workspace runs one typecheck and one build command. It emits one artifact directory per Worker.

Tests and environment checks remain separate by entrypoint.

## Verification

1. Cloudflare infrastructure deploys both Worker entrypoints from `apps/sendblue-channel`.
2. Ingress bindings contain no Sendblue API key or secret key.
3. Egress bindings contain the outbound Sendblue credentials.
4. The portable Channel Runtime imports only the public Sendblue Channel exports.
5. Boundary checks allow `@bob/sendblue` from only approved workspaces.
6. The repository test configuration runs both entrypoint test suites.
