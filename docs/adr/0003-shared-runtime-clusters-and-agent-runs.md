# ADR 0003: Shared Runtime clusters and Agent Runs

Status: Accepted
Date: 2026-08-17

## Context

The first managed topology installed one complete Bob Runtime for each Owner. This model duplicated Core,
Agent Worker, PostgreSQL, Redis, and Object Storage resources.

The Agent Worker also used one Core endpoint, one caller secret, one credential path, and process-local run
control. These rules prevent safe horizontal worker scaling.

Core waits for the full Agent Run HTTP response. A queue migration therefore needs a durable continuation. A
queue change alone cannot preserve reply, Tool recovery, and usage rules after a process failure.

## Decision

Run many Owners in one shared Runtime Cluster. Keep Owner data isolated through trusted identity, scoped
queries, per-Owner encryption, and tenant-linked Database constraints.

Create a Runtime-owned `runtime-control` Module. It defines release roles, protocol compatibility, required
shared services, and content-free Runtime observations. It contains no Owner, message, prompt, Tool, attachment,
or credential data.

Create one Agent Runs Application Module. Its public Interface accepts immutable work, durable cancellation,
and status queries. It owns Agent Run admission, snapshots, attempts, leases, fences, checkpoints, retry policy,
outcomes, and dispatch and continuation outboxes.

PostgreSQL is authoritative for Agent Runs. BullMQ carries small replay-safe pointers. Queue delivery does not
grant execution authority.

Split Agent Run processing into submission, execution, and finalization phases. The Agent Worker records one
fenced outcome before it acknowledges the queue item. Core finalizes the saved outcome without rerunning the
model.

Pin each Agent Run to one execution pool, Deployment Profile, Capability catalogue generation, job protocol,
Core Gateway protocol, and checkpoint loop version.

Use ConnectRPC and Protobuf for the Control Plane to Runner Interface. Keep Runtime data-plane transports behind
Effect Interfaces.

## Consequences

Agent Workers can scale horizontally without local ownership state.

PostgreSQL and Redis failures have explicit recovery behavior. External model execution remains at-least-once,
but only one fenced outcome can become authoritative.

The Runtime needs shared PostgreSQL, Redis, and Object Storage Adapters. Each process role needs a bounded
Database connection pool.

The Control Plane manages Runtime Clusters and role capacity. It does not manage Owners or inspect Agent Run
data.

The isolated Bob Instance and Warm Sandbox topology is superseded. Historical decisions remain in the ADR log.
