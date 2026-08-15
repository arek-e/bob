# ADR 0003: Use one Bob agent runtime with domain-owned workflows

- Status: Accepted for the first release
- Date: 2026-08-10
- Scope: Agent implementation and repository structure

## Context

Bob needs a legible agent implementation with strong safety controls.

The implementation must support reminders, memory, training, and journals.

It must also support a person who can have memory impairment.

We reviewed Pi, Waku Agent, OpenClaw, Hermes Agent, and Boop Agent.

Waku provides the clearest teaching implementation.

Its main modules map directly to its architecture diagram.

It uses an explicit loop, bounded history, memory categories, traces, and evaluations.

Waku is local-first and describes itself as a blueprint, not production software.

Bob needs stronger durability, privacy, provenance, and confirmation rules.

## Best features from each reference

| Reference        | Adopt                                                        | Do not adopt                                            |
| ---------------- | ------------------------------------------------------------ | ------------------------------------------------------- |
| Pi               | `pi-ai` model streaming, provider auth, and tool schemas     | Coding tools and a second agent loop                    |
| Waku             | Visible composition, capability exclusion, and release gate  | Automatic fact promotion and self-editing skills        |
| OpenClaw         | Provenance, supersession, typed intents, and layered policy  | Broad plugins, host authority, and in-process queues    |
| Hermes           | Staged writes, recovery ledger, and content-free health      | Shell, browser, and autonomous skill changes            |
| Boop             | Sendblue automation, task scopes, and optional work receipts | Prompt-only enforcement, local timers, and content logs |
| Sendblue adapter | Provider event types and transport operations                | Provider state as application state                     |

No single reference supplies Bob's complete design.

Bob combines selected features behind Bob-owned interfaces.

[ADR 0004](0004-alchemy-effect-drizzle.md) defines the implementation stack.

[ADR 0005](0005-varlock-environment-contracts.md) defines environment contracts.

[ADR 0007](0007-bob-owned-pi-ai-loop.md) defines Bob's direct `pi-ai` loop.

## Decision

The Bob Pi loop owns the only conversational agent loop policy.

Do not add a second agent loop inside Pi or another package.

Do not run Codex app-server inside the Pi path.

Do not use sub-agents in the first release.

Keep Bob's durable state in the core Worker.

Use deterministic domain workflows outside the model.

### One agent run

Each inbound event creates one durable processing record.

Create an agent run only when the task needs language judgment.

Store an immutable input snapshot for that agent run.

Append attempts and status changes. Do not change the input snapshot.

Use this sequence:

1. Claim the inbound event under the owner's session lock.
2. Resolve deterministic channel commands before Pi.
3. Resolve urgent-safety responses before Pi.
4. Build one policy-cleared context pack.
5. Load the reviewed capability catalogue for the run.
6. Create one ephemeral Bob Pi loop with a direct `pi-ai` model context.
7. Run the loop with explicit turn, tool, time, and output limits.
8. Execute each tool through a typed core interface.
9. Store the run result and response intent.
10. Send the response later through the delivery outbox.

An owner-scoped Durable Object serializes runs for the owner.

D1 claims remain authoritative for run state.

The Pi host does not own durable conversation state.

A retry rebuilds the same run input from stored records.

The model never receives Sendblue credentials or Cloudflare bindings.

### Context assembly

The core Worker builds the context pack.

The Bob Pi loop renders that pack into a `pi-ai` model context.

Load candidate items through one complete and ordered static registry of Context source Modules.

Each source returns candidate Context items only.

Keep source precedence, privacy, budgets, deduplication, and final assembly in ContextStore.

Adding a Context source Module requires compile-time registration and conformance tests.

Do not discover, install, self-register, or hot-reload Context source Modules.

The pack contains:

- Current local time and time zone
- One pending short-reply binding
- A small confirmed profile pack
- Relevant confirmed facts with source labels
- The current plan artifact and relevant lexical recall
- Reviewed skill instructions
- Explicit uncertainty and conflict markers

Do not send D1 rows directly to Pi.

The current request supplies the current user text separately.

ADR 0010 permits one bounded current turn and recent delivered same-channel turns.

Outside that contract, never send stored raw messages or journal text to Pi.

Do not send journal summaries to Pi in the first release.

This stricter privacy rule replaces the earlier conversation-window design.

Mark recalled content as data.

Use deterministic retrieval rules in the first release.

Always include the small confirmed profile pack.

Retrieve personal records for recall, reminder, and training intents.

Let `memory_search` handle deeper follow-up searches.

Do not add a model-only retrieval gate yet.

A future gate can skip optional retrieval after evaluation.

Its failure must return to the deterministic plan.

It must never bypass access or sensitivity policy.

### Tools

Register the reviewed capability catalogue for each model-directed run.

Do not use prompt wording or run type to add or remove Tools.

[ADR 0012](0012-model-directed-capability-selection.md) defines Capability Modules and catalogue
identity.

Pi tool handlers call narrow core Worker routes.

The core Worker checks authorization and domain invariants again.

Every mutating call includes a run ID, tool-call ID, and idempotency key.

The Bob Pi loop owns the tool gate and executes tools in code.

Run mutating tools sequentially.

Return structured results with stable error codes.

Do not rely on prompt text to prevent duplicate mutations.

Keep these first-release tool groups:

- Reminders
- Memory proposals and recall
- Journal metadata and private links
- Gym, routines, and workouts
- Owner locality settings

Do not expose transport, authentication, shell, browser, filesystem, or package tools.

### Memory

Adopt Waku's three useful memory views with safer records.

- Semantic memory maps to confirmed fact revisions and evidence.
- Episodic memory maps to dated messages, reminders, workouts, and approved summaries.
- Procedural memory maps to reviewed `SKILL.md` files.

The application database remains authoritative.

Generate Obsidian-compatible Markdown as a human-readable projection.

Batch memory extraction outside the response path.

Extraction creates memory candidates with evidence.

It never creates confirmed facts directly.

Each candidate keeps its source IDs and origin class.

Recalled, tool-derived, assistant, and background text cannot confirm a fact.

System records can confirm only facts created by their own completed command.

The model cannot update or delete a confirmed fact.

A correction creates a proposed revision and preserves history.

Ranking decay never deletes a source record or its evidence link.

Do not load raw journal text into Pi during the first release.

Do not let Pi edit its persona or create skills.

### Workflows

Use plain domain state machines for reminders, delivery, and memory review.

Do not add a generic graph engine in the first release.

The reminder module already defines its durable workflow.

The delivery module already defines its durable workflow.

The memory module already defines its review workflow.

Add a graph module only after two real workflows need shared graph behavior.

Scheduled reminders do not need Pi.

Scheduled summaries use a fresh agent run and a narrow tool set.

Persist each external action before dispatch.

Use `pending`, `claimed`, `executing`, `completed`, `failed`, and `unknown` states.

Do not retry an `unknown` external action before reconciliation.

### Events and observability

Use Bob loop lifecycle events for agent activity.

Use Hermes-style content-free health events.

Keep OpenClaw's content capture disabled by default.

Waku's observer shape remains a design reference only.

Emit typed lifecycle events for runs, model calls, tools, and failures.

Record model, duration, token counts, tool name, status, and opaque identifiers.

Do not record prompts, replies, tool arguments, phone numbers, or model reasoning in traces.

Keep private content in policy-controlled application records.

Use one correlation ID across ingress, run, tool, outbox, and delivery events.

### Evaluation

Adopt Waku's separation between deterministic and judged evaluation.

Deterministic evaluation proves state and safety behavior.

Judged evaluation measures clarity, warmth, and usefulness.

A judge cannot waive a deterministic failure.

The release gate requires all deterministic safety cases to pass.

Required suites include:

- Tool selection and argument shape
- Reminder state transitions and time zones
- Duplicate tool and webhook delivery
- Ambiguous short replies
- Conflicting and unsupported memories
- Source labels and uncertainty language
- Journal privacy policy
- Training pain and machine-confusion stops
- Provider authentication and quota failures
- Redaction and content-free telemetry

Run deterministic checks with offline fixtures.

Run harmless live checks in production only after owner approval.

Keep Sendblue disabled until its live URLs and reconciliation checks are ready.

## Repository structure

Deployable seams follow runtime and credential changes.

Module seams follow domain ownership and change locality.

```text
.env.schema             Shared non-sensitive environment definitions

apps/
  core-worker/          D1 authority, API, Queue consumer, Cron, and reminder clock
    .env.schema         Core Worker deployment bindings
    src/
      index.ts          Cloudflare entrypoints only
      composition.ts    Complete module wiring
      entrypoints/      HTTP, Queue, Cron, and Durable Object adapters
      modules/
        conversations/  Inbound events, runs, ordering, and short replies
        delivery/       Outbox, attempts, callbacks, and opt-out state
        reminders/      Schedules, occurrences, claims, and reconciliation
        context/        Context selection, budgets, sources, and disclosure
        policy/         Access, confirmation, and channel decisions
        memory/         Candidates, facts, evidence, recall, and projections
        journal/        Private handoffs, entries, metadata, and deletion
        training/       Gyms, equipment, routines, sessions, and sets
      migrations/       Ordered D1 migrations
  sendblue-ingress/     Public webhook; webhook secret only
    .env.schema         Ingress-only Sendblue fields
  sendblue-egress/      Outbound Queue; Sendblue send credentials only
    .env.schema         Egress-only Sendblue fields
  agent/                Private Node host for Pi
    .env.schema         Node bootstrap configuration
  ui/                   Private owner interface
    .env.schema         Public browser configuration only

packages/
  contracts/            Versioned cross-runtime schemas
  sendblue/             Provider verifier, decoder, client, and reconciler
  pi-agent/             Bob's Pi loop, prompts, tools, auth, and safety
  observability/        Content-free events and runtime adapters

tools/
  sendblue-reconcile/   Account webhook check and apply command
    .env.schema         Sendblue account reconciliation fields
  pi-smoke/             Pi login, refresh, model, and tool smoke checks
  agent-evals/          Public Pi-agent evaluation runner

evals/
  deterministic/        Exact state and safety assertions
  judged/               Response-quality scoring
  scenarios/            Versioned personal-assistant cases
  fixtures/             Redacted provider and model events

skills/                 Reviewed procedural instructions
infra/
  cloudflare/            Workers, D1, R2, Queues, Access, and domains
    .env.schema          Alchemy and Cloudflare deployment fields
  kubernetes/            Private Pi host deployment
  openbao/               Policies, roles, and secret paths
docs/
  adr/                   Architecture decisions
  runbooks/              Operations and recovery
```

Create only modules required by the current milestone.

The first slice creates conversations, delivery, reminders, context, and policy.

Do not create empty memory, journal, or training folders early.

### Application composition

Each app has one visible `composition.ts` module.

That module wires configuration, adapters, domain modules, and telemetry.

It also composes one visible Effect application Layer.

Platform entrypoints contain no domain rules.

Do not use a reflection-based dependency container.

The composition module must stay readable in one screen when practical.

### Core modules

Keep D1 queries beside the module that owns their invariants.

Keep each Drizzle schema beside its owning module.

Expose database operations through local Effect services.

Use D1 batch operations for atomic writes.

Use real local D1 in module tests.

Do not create generic repository interfaces for D1.

Keep global numbered migrations in `apps/core-worker/migrations`.

The modules own these records:

- Conversations owns messages, inbound events, agent runs, and short replies.
- Delivery owns outbox messages, delivery attempts, callbacks, and opt-out state.
- Reminders owns reminders, occurrences, actions, and scheduler outbox rows.
- Context owns context plans and context-pack construction.
- Memory owns candidates, facts, revisions, evidence, and search projections.
- Journal owns entries, attachments, handoffs, and privacy deletion effects.
- Training owns gyms, equipment, routines, workouts, and sets.
- Policy owns stable authorization and disclosure decision codes.

### Cross-runtime packages

`@bob/contracts` contains Effect wire schemas. It does not expose D1 rows.

Use explicit subpath exports for channel, jobs, agent, tools, delivery, and UI.

Validate every value at each process seam.

`@bob/sendblue` remains provider-specific.

Do not add a generic channel interface before a second channel exists.

Ingress, egress, and the reconciliation tool consume this package.

Use explicit exports for `webhooks`, `client`, and `account`.

`@bob/pi-agent` owns every Pi import and Pi-specific type.

It owns the Bob loop, prompts, run policy, output validation, safety rules,
fallback behavior, and normalized model results. It uses `@earendil-works/pi-ai`
directly. Its public Interface uses Bob-owned run, event, tool, and error types.

Keep its public surface small:

- `createBobPiAgent`
- `runTurn`
- `getAuthStatus`
- `startDeviceLogin`

Keep Bob's policy local to this package. Pi provides model and provider support,
but it does not own Bob's loop or safety decisions.

Keep the OpenBao credential adapter inside this package.

Do not add another credential interface around Pi's existing interface.

`@bob/observability` has Cloudflare, Node, and testing adapters.

Its event schemas reject arbitrary objects and personal content.

Use explicit exports for `events`, `cloudflare`, `node`, and `testing`.

Do not create `domain`, `db`, `tools`, `config`, `utils`, or `shared` packages.

Those names split one feature across technical layers or add shallow pass-through modules.

### Dependency direction

- Packages never import apps.
- Apps never import another app's source.
- Apps communicate through validated HTTP, Queue, or service-binding contracts.
- Only `@bob/pi-agent` imports Pi packages.
- Only Sendblue apps and tools import `@bob/sendblue`.
- Only the core Worker imports D1, R2, and Durable Object types.
- Only the core Worker imports Drizzle D1 adapters and table schemas.
- Worker apps do not import `@effect/platform-node`.
- First-release code does not import `effect/unstable/*`.
- The agent host imports no Sendblue or Cloudflare binding types.
- The ingress app receives no outbound Sendblue credential.
- The egress app receives no Pi OAuth credential.
- The UI imports read-only browser contracts only.

Use explicit package subpath exports.

Block internal deep imports and cross-app imports in lint rules.

Use `workspace:*` for every internal dependency.

Set `type: module` in every workspace package.

Use one root lockfile and one pinned pnpm version.

Keep Node at version 22.19 or newer.

Do not add a task runner yet.

## Deletion test

Merge the planned agent dispatcher into the core Worker.

Deleting it moves one Queue handler without spreading new complexity.

Merge the planned scheduler Worker into the core Worker.

Deleting it keeps D1 claims, alarms, and reconciliation together.

Keep Sendblue ingress and egress separate.

Their privilege isolation justifies their small interfaces.

Remove the planned `domain`, `db`, `memory`, `tools`, and `config` packages.

Their deletion improves feature locality.

Add a new shared package only after two real consumers need one invariant.

## Verification

1. Every architecture box maps to one app or named module.
2. Each app exposes one readable composition module.
3. Import rules reject Pi outside `@bob/pi-agent`.
4. Import rules reject Sendblue outside approved consumers.
5. Import rules reject D1 outside the core Worker.
6. Every cross-runtime message passes runtime validation.
7. Core module tests run against real D1 migrations.
8. Agent evaluations call the public Pi-agent interface.
9. Fault tests stop after each durable write and external call.
10. Trace fixtures contain no personal content.
11. A memory extractor creates only proposed candidates.
12. A scheduled reminder can complete without starting Pi.
13. An owner coordinator prevents concurrent Pi runs for one owner.
14. An unknown external action cannot retry before reconciliation.

## Consequences

Bob gets one visible agent composition without another framework layer.

Domain behavior stays near its records and atomic batches.

Cross-runtime packages exist only where multiple consumers need them.

The design delays generic adapters until variation is real.

The core Worker becomes the largest deployable.

Its domain modules and entrypoint adapters keep that implementation navigable.

## Sources

- [Waku Agent](https://github.com/ShenSeanChen/waku-agent/tree/4547e9193dad298df3f30f88ebbb2f1a6f0c8c82)
- [Waku architecture](https://github.com/ShenSeanChen/waku-agent/blob/4547e9193dad298df3f30f88ebbb2f1a6f0c8c82/docs/architecture.md)
- [Waku composition](https://github.com/ShenSeanChen/waku-agent/blob/4547e9193dad298df3f30f88ebbb2f1a6f0c8c82/waku/app.py)
- [Waku loop](https://github.com/ShenSeanChen/waku-agent/blob/4547e9193dad298df3f30f88ebbb2f1a6f0c8c82/waku/loop/agent.py)
- [Waku session context](https://github.com/ShenSeanChen/waku-agent/blob/4547e9193dad298df3f30f88ebbb2f1a6f0c8c82/waku/runtime/session.py)
- [Waku memory](https://github.com/ShenSeanChen/waku-agent/blob/4547e9193dad298df3f30f88ebbb2f1a6f0c8c82/waku/memory/__init__.py)
- [Waku retrieval gate](https://github.com/ShenSeanChen/waku-agent/blob/4547e9193dad298df3f30f88ebbb2f1a6f0c8c82/waku/memory/retrieval_gate.py)
- [Waku consolidation](https://github.com/ShenSeanChen/waku-agent/blob/4547e9193dad298df3f30f88ebbb2f1a6f0c8c82/waku/memory/consolidation.py)
- [Waku tool registry](https://github.com/ShenSeanChen/waku-agent/blob/4547e9193dad298df3f30f88ebbb2f1a6f0c8c82/waku/tools/registry.py)
- [Waku memory tools](https://github.com/ShenSeanChen/waku-agent/blob/4547e9193dad298df3f30f88ebbb2f1a6f0c8c82/waku/tools/memory_admin.py)
- [Waku tracing](https://github.com/ShenSeanChen/waku-agent/blob/4547e9193dad298df3f30f88ebbb2f1a6f0c8c82/waku/ops/tracing.py)
- [Waku release gate](https://github.com/ShenSeanChen/waku-agent/blob/4547e9193dad298df3f30f88ebbb2f1a6f0c8c82/waku/ops/release_gate.py)
- [Pi AI package](https://github.com/earendil-works/pi/tree/main/packages/ai)
- [Pi provider documentation](https://pi.dev/docs/latest/providers#subscriptions)
- [OpenClaw review point](https://github.com/openclaw/openclaw/tree/8e91d6c0c195d53667f2cd221517c55fe9ad6251)
- [OpenClaw memory architecture](https://github.com/openclaw/openclaw/blob/8e91d6c0c195d53667f2cd221517c55fe9ad6251/docs/concepts/memory-architecture.md)
- [OpenClaw queue limits](https://github.com/openclaw/openclaw/blob/8e91d6c0c195d53667f2cd221517c55fe9ad6251/docs/concepts/queue.md)
- [Hermes review point](https://github.com/NousResearch/hermes-agent/tree/49c632310dd6877302e8dfa92e740b0ceddb97b8)
- [Hermes execution ledger](https://github.com/NousResearch/hermes-agent/blob/49c632310dd6877302e8dfa92e740b0ceddb97b8/cron/executions.py)
- [Hermes observability](https://github.com/NousResearch/hermes-agent/blob/49c632310dd6877302e8dfa92e740b0ceddb97b8/docs/observability/README.md)
- [Boop Agent](https://github.com/raroque/boop-agent/tree/31979130b1371acd9defbea115279a06c63c1fb4)
