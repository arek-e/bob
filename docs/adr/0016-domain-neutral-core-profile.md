# ADR 0016: Compose a domain-neutral General Agent Core through static deployment profiles

- Status: Accepted
- Date: 2026-08-15
- Scope: Product identity, Capability composition, Context composition, and migration
- Amends: ADR 0003, ADR 0004, ADR 0006, ADR 0008, ADR 0009, ADR 0010, ADR 0012, and ADR 0013

## Context

Bob's first implementation made reminders, journals, training, settings, and connections part of
one required runtime.

Static Capability Modules, catalogue generation, and Context source Modules improved review and
rollout safety. They did not make a niche domain optional. The complete catalogue still meant every
Tool in the repository, and the complete Context source registry still meant every current source.

This structure fails the deletion test. Removing one vertical Module still changes shared contracts,
the Pi loop, ContextStore, conversation orchestration, composition, deployment, and evaluations.

The research direction is a general continuity agent. Its stable core is retrieval, memory, a
Bob-owned Pi harness, policy, conversation, planning, and delivery. Product domains are reviewed
extensions of that core.

## Decision

Define one domain-neutral General Agent Core and one minimum core profile.

The core profile contains these Modules:

- Conversation turns, immutable Agent runs, steering, and receipts.
- The Bob-owned Pi harness and its bounded loop policy.
- Context assembly and general retrieval.
- Owner memory, evidence, revisions, and correction.
- General plan artifacts.
- Cross-capability policy, idempotency, recovery, and delivery.
- Owner locality settings and one selected Channel Adapter.

The core profile contains no reminder, journal, training, or external-connection capability.

Treat reminders, journals, training, and external connections as Vertical Modules.

A deployment profile is one reviewed and immutable composition of the core profile and zero or more
optional Capability Modules. Composition happens in source and configuration before the process
starts. Message wording, a model decision, stored content, or a runtime request cannot change the
profile.

Build the Capability catalogue from the complete static set selected by that deployment profile.
Every Agent run in the profile receives the same catalogue. Every Tool still belongs to exactly one
Capability Module. Catalogue generation still includes Tool definitions and safety metadata, and
Core and Agent still reject generation skew before model execution.

Include the deployment profile identity in the catalogue generation. Store the profile identity and
catalogue generation in each new Agent run. Core and Agent reject a new run when either value differs.

Build the Context source registry from the complete ordered static set selected by the same
deployment profile. ContextStore still owns precedence, privacy, budgets, deduplication, and final
Context pack assembly. A Context source Module cannot add Tool authority.

Keep runtime discovery, package installation, self-registration, mutable hooks, and hot reload out
of both registries.

Each Vertical Module owns its Tool definitions, execution Adapter, deterministic
workflows, source projections, policy, routes, schedules, evaluation pack, and safety metadata.
Shared core Modules consume these through reviewed Interfaces. They do not identify a capability by
domain words or import its persistence schema.

The default deployment profile becomes the core profile after migration checks pass. A transitional
profile can retain all current optional Capability Modules while the refactor is incomplete.

Preserve existing domain tables, migrations, records, and owner data. Removing a Capability Module
from a deployment profile stops new use of that capability. It does not delete its data. A later
reviewed migration can archive or delete data under the owning Module's privacy policy.

Keep legacy readers behind the owning Vertical Module's Adapter. A legacy vertical record does not
enter a core profile Context pack.

Require every Vertical Module to pass this deletion test: removing its profile registration must not
require changes to the Pi harness, retrieval, memory, conversation, policy, or delivery Modules. The
General Agent Core must still compile, test, deploy, and run.

The core release gate covers harness limits, retrieval, relevance, provenance, memory revision,
abstention, grounding, injection resistance, and action evidence. Each Vertical Module owns an
additional evaluation pack.

## Consequences

Bob's product identity no longer depends on reminders, journals, or training.

One deployed profile remains deterministic and reviewable. Different reviewed deployments can have
different catalogues without runtime capability discovery.

Deleting a Vertical Module becomes a composition change. Its domain knowledge does not
move into the harness, retrieval, memory, conversation, or shared contracts.

The refactor needs profile-aware catalogue and Context composition, domain-owned Adapters, a
core-only verification target, and migration compatibility for stored records.

ADR 0003 remains authoritative for one durable Bob-owned Agent run, immutable inputs, domain-owned
workflows, and delivery fences. Its first-release domain list is superseded.

ADR 0012 remains authoritative for model-directed Tool selection, static registration, catalogue
generation, and rollout-skew rejection. Its repository-wide definition of a complete catalogue is
superseded by profile-specific completeness.
