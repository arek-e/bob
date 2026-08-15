# ADR 0015: Support managed Instance activation and channel routing

- Status: Accepted
- Date: 2026-08-15
- Scope: Managed accounts, first-event routing, Runtime materialization, and Instance isolation
- Related: Bob Control Plane ADR 0007, "Run a managed Instance platform"
- Amends: ADR 0001, ADR 0002, ADR 0004, ADR 0005, ADR 0009, and ADR 0014

## Context

The managed product needs one Bob Instance for each Owner.

Signup or an authorized first Channel event can activate that Instance.

The existing Sendblue ingress binds one line and one allowed sender to an existing Runtime.

The existing deployment assumes one static Cloudflare stack and one fixed OpenBao credential path.

The Bob Control Plane must not receive owner identity data or message content.

Managed execution must use clean warm capacity without sharing Owner state.

## Decision

### Account and Runtime model

Keep one Owner in one Bob Instance.

Do not make one Bob Runtime a multi-Owner application.

The application data plane owns Managed Accounts, sender identities, and owner records.

It sends one opaque Provisioning subject to the Control Plane.

Bob Console signup and authorized first typing converge on the same idempotent activation process.

### Cloudflare ownership

Runtime Alchemy owns portable and self-hosted infrastructure plans.

It does not write managed production resources.

`teampitch-ops` is the only writer for managed production Cloudflare resources.

Managed automation consumes reviewed Runtime contracts and plans through narrow Interfaces.

Each managed Bob Instance receives separate D1 and Durable Object resources.

Use Instance-scoped R2 access where the Runtime contract requires object storage.

### Managed Channel Router

Run one Managed Channel Router for each managed environment or region.

The Module belongs to the application data plane.

It owns protected sender-to-Instance mappings.

It verifies the Sendblue account secret, destination line, event class, and sender authorization.

Unknown or unauthorized senders do not create a Managed Account or billable infrastructure.

The Module durably stores one Staged channel event before it acknowledges the webhook.

It requests activation with an opaque Provisioning subject and an idempotency key.

It releases the event to the assigned Bob Instance only after readiness succeeds.

Provider event deduplication remains independent from provisioning idempotency.

Provider callbacks route through durable message and Instance references.

The Control Plane never receives phone numbers, message text, or Sendblue records.

Self-hosters can keep the fixed allowlist in ADR 0002.

### Per-Instance identity

Give each managed Bob Instance unique and revocable workload identities.

Use separate identity references for Connections Gateway, storage, ingress, Runner, and Runtime secret access.

The Connections Gateway derives Instance scope from verified identity.

Request content cannot select another Instance.

Store managed Runtime secrets below an Instance-specific path under `ops/apps/prod/bob/instances`.

Use one atomic Pi credential record for each Instance.

The application data plane owns owner login and credential enrollment.

The Control Plane stores identity references and expected versions only.

### Runtime materialization

Bob Runner acquires a reviewed deployment contract from an authenticated artifact source.

It verifies the contract digest before use.

It caches only immutable contracts and images across Instances.

It resolves exact OpenBao references through its local workload identity.

It writes Secret Projections with owner-only permissions and atomic replacement.

Secret values never cross the Runner Interface.

The Runtime Driver receives prepared local references. It does not fetch Control Plane secrets.

Rotation creates a new projection version and desired generation.

Sandbox destruction removes every local projection and workload credential.

### Warm execution and isolation

A managed Warm Sandbox can contain a base image, Bob Runner, verified contracts, and immutable image caches.

It contains no Owner state, credentials, storage attachment, messages, or Secret Projection.

Claim attaches fresh Instance resources and identities.

A claimed Sandbox is destroyed after suspension or deletion. It never returns to the warm pool.

Managed production uses one strong isolation domain for each Owner.

A shared Docker daemon remains suitable for development and single-owner self-hosting only.

The Runtime Driver rejects Resource Policies that its Implementation cannot enforce.

## Failure behavior

A delayed activation keeps the Staged channel event durable.

A failed activation does not deliver the event to another Instance.

A duplicate webhook does not create another event or Instance.

An uncertain Sandbox cleanup quarantines that Sandbox until destruction succeeds.

Identity revocation stops future Connections Gateway and secret access.

Existing durable application data survives Runner or Sandbox replacement.

## Verification

Test duplicate signup and first-typing activation for one Managed Account.

Test unauthorized senders and unknown lines without infrastructure changes.

Test delayed activation, webhook replay, callback routing, and event release after readiness.

Test unique Instance identities and cross-Instance access rejection.

Test contract digest failure, exact Secret Projection versions, atomic rotation, and cleanup.

Test that warm capacity contains no Owner data before claim.

Test that claimed capacity cannot return to the pool.

Test that each managed Resource Policy has an enforcing Runtime Driver Implementation.

## Consequences

Managed activation becomes an application-plane and Control Plane workflow.

The Runtime remains portable and single-Owner.

Shared routing and Connections Gateway Modules reduce repeated infrastructure without sharing authority.

Strong isolation and separate Instance storage increase managed infrastructure cost.

The managed product needs `teampitch-ops` Adapters for resource creation and deletion.

## Current delivery boundary

The first managed platform phase supports authorized first-event activation and delivery after the
Instance becomes ready.

Active Instances stay hot. The Control Plane scales clean Warm Sandbox capacity without moving an
active Owner.

Suspension, deletion, and active reassignment stay closed in this phase. They require accepted
backup retention, storage handoff, and ingress-drain evidence before an Interface can expose them.
