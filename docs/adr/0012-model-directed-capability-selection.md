# ADR 0012: Model-directed capability selection

- Status: Accepted; catalogue scope amended by ADR 0016
- Date: 2026-08-14
- Scope: Agent Tool availability, context retrieval, and plan artifacts

## Context

Bob is a general personal continuity agent with bounded authority.

The first implementation selected Tools with English and Swedish keyword rules.
It also loaded reminder and training records from those rules.

This made new wording and new domains depend on more regular expressions.
It also made short replies depend on capability hints from prior runs.

## Decision

Give every agent run in one deployment profile the same reviewed capability catalogue.

Build the catalogue from the complete static set of Capability Modules selected by that profile.

Keep each domain's Tool definitions, feature attribution, and safety metadata in its Capability
Module.

Every Tool belongs to exactly one Capability Module.

Conformance checks reject missing Tools, duplicate ownership, and unowned safety metadata.

A Capability Module cannot grant authority beyond its owning domain Module.

Derive one deterministic generation from the complete profile catalogue content.

Store that generation in each new immutable agent run request.

Reject a new run before model execution when its generation does not match the Agent catalogue.

Accept stored requests without a generation only through the explicit legacy snapshot replay path.

The generation detects rollout skew. It does not grant Tool authority.

Adding a Capability Module requires compile-time registration and conformance tests.

Do not discover, install, self-register, or hot-reload Capability Modules.

Let the model select a Tool from the owner's meaning and current turn.
Do not use message keywords to add or remove model Tools.

Keep mutation authority in each domain Module.
Tool availability does not prove owner intent.

Keep confirmed profile records, recent conversation, the current plan artifact, and lexical recall in
the context pack.
Read domain records through reviewed Tools when the request needs them.

Use one general `plan` artifact for reusable structured plans.

Keep legacy artifact readers behind the owning Vertical Module during migration.

This decision supersedes the short follow-up Tool selection section in ADR 0010.

## Consequences

New wording and languages do not require Tool routing changes.

New capabilities enter the agent through the reviewed Tool catalogue.
Their domain Modules still require policy, tests, audit records, and recovery behavior.

Agent telemetry uses the assistant feature for general runs.
Individual Tool spans keep their domain feature.

The context pack no longer copies active reminder or training records because of keyword matches.
The model must use the correct read Tool for those records.
