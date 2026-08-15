# ADR 0014: Publish portable deployment contracts for Bob Runner

- Status: Accepted
- Date: 2026-08-15
- Scope: Runtime deployment boundary and managed orchestration
- Related: Bob Control Plane ADR 0004, "Use a fenced Runner pull protocol"
- Amended by: ADR 0015 for Runtime materialization and isolated lifecycle

## Context

Bob Runtime must support self-hosted and managed installations.

The managed Control Plane needs a stable way to deploy one reviewed Runtime Release.

The Runtime cannot depend on Coolify, Kubernetes, KEDA, or another hosting product.

The private Control Plane cannot own Runtime application code or application data.

Networks and executors can retry work after uncertain results.

## Decision

Bob Runtime publishes one versioned deployment contract with each reviewed release.

The contract declares:

- its schema version;
- the deployment file and its digest;
- every required service and immutable image name;
- required configuration and secret names;
- readiness behavior;
- the reviewed backup command.

The release record includes the contract digest, its reviewed HTTPS locator, and every immutable image digest.

The locator must bind to the reviewed Runtime source revision.

The contract contains no secret value, managed resource identifier, or host-specific path.

Bob Runner consumes this contract through a Runtime Driver.

Docker Compose is the current reviewed Runtime Driver.

Future Drivers can use Kubernetes with KEDA or another executor.

The Control Plane sends complete desired state through its versioned ConnectRPC Interface.

The Runner initiates all Control Plane connections. It journals work before it changes Runtime state.

Each Operation uses at-least-once delivery, a Lease, and a monotonic Instance fence.

The Runtime Driver must reject a fence below its durable maximum.

Secret values reach the Runtime through protected local projections. The protocol carries only secret references and versions.

Coolify can host the Control Plane, Runner, or Runtime. It is not part of the deployment contract.

## Repository ownership

The Bob Runtime repository owns the deployment contract schema and Runtime application images.

The Bob Control Plane repository owns the Runner protocol, managed Runner, assignments, Leases, and assurance policy.

The repositories use digests and versioned Interfaces at their boundary.

Neither repository copies the other repository's domain model.

## Consequences

Managed orchestration can change hosts without changing Runtime policy.

Self-hosters can use the same reviewed contract without the managed Control Plane.

Release automation must verify the contract and all image digests before it creates desired state.

Driver implementations need conformance tests for retries, recovery, deadlines, and stale fences.
