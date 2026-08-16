# ADR 0021: Provider-neutral runtime systems and Interfaces

## Status

Accepted

## Context

Bob supports more than one deployment provider.

The architecture used provider names as system names. For example, it described Redis as the
queue, PostgreSQL as the database, and Durable Objects as run coordination.

This language hides responsibility. It also makes a provider change look like an application
rewrite. Provider types currently reach Core composition, job handlers, storage, scheduling, and
run coordination.

Bob must keep the current Cloudflare deployment while the portable deployment stays usable.
Both deployments must preserve idempotency, ordering, privacy, and recovery behavior.

## Decision

Name systems by responsibility. Use these names in architecture, application documentation,
logs, smoke output, and validation messages:

| System              | Responsibility                                      | Cloudflare Adapter              | Compose Adapter               |
| ------------------- | --------------------------------------------------- | ------------------------------- | ----------------------------- |
| Core Runtime        | API, UI, conversation, and core workflow invariants | Worker host                     | Node process                  |
| Agent Runtime       | Bounded model and Tool loop                         | Agent service                   | Node process                  |
| Channel Runtime     | Inbound normalization and outbound delivery         | Worker host and Channel Adapter | HTTP host and Channel Adapter |
| Job Queue           | Durable work publication and attempts               | Queues                          | BullMQ over Redis             |
| Application Storage | Durable records and atomic changes                  | D1                              | PostgreSQL                    |
| Object Storage      | Private objects                                     | R2                              | Filesystem or S3              |
| Run Coordinator     | Owner-run ordering and delayed wakes                | Durable Objects                 | Delayed Job Queue jobs        |
| Scheduler           | Periodic maintenance and recovery                   | Cron                            | Node interval                 |

The first column is the approved system name. Provider names in the last two columns describe
Runtime Adapters. Compose service keys use the first-column role names where practical.

Put hosting behavior behind small Interfaces owned by Bob. Create these seams in this order:

1. Job publication and job attempts.
2. Scheduled work and owner-run coordination.
3. Object Storage.
4. Module-owned Application Storage.
5. HTTP hosting and static assets.

Provide one Adapter for each supported provider at each seam. Keep provider types in Adapters and
entrypoints. General Agent Core Modules must not import Cloudflare, BullMQ, Redis, PostgreSQL, D1,
R2, Durable Object, or Cron types.

Do not make one generic database Interface. Each owning Module keeps its domain operations and
invariants. It can use an Application Storage Adapter for D1 or PostgreSQL.

Keep application idempotency in Application Storage. Job acceptance never proves job completion.
A failed publication has an unknown enqueue outcome.

One Runtime release contains every selected Adapter. Release assurance tests every supported
Runtime Adapter and records the selected Adapter set in content-free release metadata.

## Migration

Move one seam at a time. Keep behavior unchanged while each provider Adapter becomes explicit.

The Job Queue seam is first. Channel Runtime ingress publishes through the Job Queue Interface
before Core Runtime consumers move. The portable Job Queue Adapter then uses the same typed jobs
and publication contract.

Do not remove a provider resource until its replacement preserves data and passes recovery tests.
Do not run two Adapters as concurrent authorities for one Bob Instance.

Update system names in deployment files, smoke checks, and operator documentation when a seam
moves. Keep provider names in Adapter names, provider configuration, and provider test fixtures.

## Consequences

Cloudflare and the portable deployment become Runtime Adapter choices.
They are not separate application architectures.

The release process can test one complete Runtime with each supported Adapter set.
Production can migrate without one large rewrite.

Bob has more Adapter code during migration. Conformance tests must keep the Implementations equal.

This decision reopens the provider-specific clauses in ADRs 0003, 0004, 0009, 0010, 0011, and 0017. Those clauses remain active for their provider Adapters until each replacement is complete.
