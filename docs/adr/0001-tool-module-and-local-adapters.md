# ADR 0001: Tool Module and local Adapters

Status: Accepted
Date: 2026-08-17

## Context

Tool contracts were part of the capabilities feature. Tool Adapter registration was part of conversations.
This split mixed provider-neutral Tool seams with application workflow ownership.

Feature and domain Modules own their Tool behavior. The Agent Module needs definitions without domain
Implementations. The conversation Module must keep durable run authority, claims, replay, and mutation rules.

Promise-based Tool Adapters also created nested Effect runtime boundaries. These boundaries weakened typed
errors, Layer composition, and span parentage.

## Decision

Create `@bob/tools-types` for provider-neutral Tool contracts and static Capability catalogues.

Create `@bob/tools-service` for static Adapter registration and Effect-native dispatch.

Keep each Tool definition and Adapter in its owning feature or domain Module. Every Tool stays in exactly one
Capability Module. Deployment Profiles continue to select reviewed Capability Modules and Adapters statically.

Keep run authority, durable claims, replay, recovery, and mutation limits in the conversation Module. The Tool
Module does not own these application rules.

Tool Adapters return `Effect` values with typed errors. The registry wraps each Adapter execution in
`bob.tool.domain`. The durable executor wraps its lifecycle in `bob.tool.claim`. The HTTP seam wraps the full
request in `bob.tool.execute`. Effect scopes end each span on success, failure, or interruption.

Do not add runtime discovery, package self-registration, hot reload, or mutable lifecycle hooks.

## Consequences

The Agent Module depends on Tool definitions, not domain Implementations.

Feature and domain code keeps high Locality. A Tool's schema, safety metadata, and Adapter remain near its rules.

The conversation Module keeps the safety invariants that need its durable records.

The Tool service can depend on observability. Tool types cannot. This rule prevents a dependency cycle.

The shared value schemas move to `@bob/shared-types`. They are not Tool concepts.
