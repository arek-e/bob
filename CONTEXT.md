# Bob context

Status: product and architecture context  
Updated: 2026-08-16

## Product

Bob is a private general continuity agent for one owner.

Bob's core purpose is continuity through retrieval, memory, and a bounded agent harness.

Bob starts with the General Agent Core. A deployment can add Vertical Modules without changing the
agent harness.

The first Channel Adapter uses iMessage through Sendblue.

Bob must stay simple, predictable, source-based, and easy to correct.

## Long-term vision

Bob is general in understanding and planning across day-to-day life.

Bob gains broad capability through reviewed Capability Modules and approved connections.

Bob keeps explicit and bounded authority as its capability grows.

Bob uses iMessage as the stable conversation interface.

Bob uses the private UI for setup, review, recovery, and consequential approvals.

Bob learns owner preferences from explicit statements and corrections.

Bob does not silently promote inferred preferences into confirmed memory.

Bob can become proactive when a grounded signal shows a likely owner need.

Bob must limit unnecessary questions, actions, and interruptions.

Bob improves through owner feedback and reviewed changes.

Bob does not rewrite its production policy or grant itself new authority.

The authority model follows these rules:

- Read approved data only when a request or approved proactive policy requires it.
- Execute a reversible change when owner intent and the target are clear.
- Ask before a consequential, ambiguous, externally visible, or hard-to-reverse change.
- Record the result of each external action and disclose an unknown result.
- Provide correction, cancellation, or undo when the domain supports it.
- Stop access when the owner revokes a connection or capability.

## System map

These names describe responsibilities. They are stable across deployment providers.
Provider names appear only in Runtime Adapter details, configuration, and implementation notes.

| System              | Responsibility                                                         | Runtime Adapter examples                                                |
| ------------------- | ---------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Core Runtime        | Serves the API and UI. Owns core conversation and workflow invariants. | Node process                                                            |
| Agent Runtime       | Runs the bounded model and Tool loop.                                  | Compose Adapter: Node process                                           |
| Channel Runtime     | Receives normalized events and sends replies.                          | Sendblue Adapter; Compose Adapter: HTTP host                            |
| Job Queue           | Publishes durable work and tracks attempts.                            | Cloudflare Adapter: Queues; Compose Adapter: BullMQ over Redis          |
| Application Storage | Stores durable relational records and atomic changes.                  | PostgreSQL with Drizzle ORM                                             |
| Object Storage      | Stores private objects outside relational records.                     | Cloudflare Adapter: R2; Compose Adapter: filesystem or S3               |
| Run Coordinator     | Serializes owner runs and schedules delayed wakes.                     | Cloudflare Adapter: Durable Objects; Compose Adapter: delayed jobs      |
| Scheduler           | Starts periodic maintenance and recovery work.                         | Cloudflare Adapter: Cron; Compose Adapter: Node interval                |
| Observability       | Exports content-free health, metrics, logs, and traces.                | Cloudflare Adapter: telemetry; Compose Adapter: OpenTelemetry Collector |

The Core Runtime composes these systems through provider-neutral Interfaces.
One deployment selects one Adapter for each system.

The primary app catalogue uses the portable Node Runtime with PostgreSQL, BullMQ, and filesystem or
S3 Adapters. Cloudflare compatibility Implementations live in `packages/cloudflare` during
migration. The UI remains a separate browser app.

The root `compose.yaml` is the primary portable deployment profile.

Infrastructure as code lives in `iac`. Each top-level directory names its deployment system.
Each runnable app owns its Dockerfile.

## Non-goals

Bob is not an emergency system.

Bob is not a medication-safety system.

Bob is not an unbounded computer-control agent.

Bob does not receive arbitrary access or authorize new capabilities for itself.

Bob is not a multi-user assistant in the first release.

Bob does not expose shell, browser, filesystem, or arbitrary MCP tools.

## Domain language

- **Owner:** The one person Bob serves.
- **Owner data key:** One per-Owner encryption key wrapped by the active data key-encryption key.
- **Owner settings:** The owner's time zone, locale, and time format.
- **Channel Adapter:** One reviewed transport Adapter that converts provider traffic to and from Bob's channel Interface.
- **Channel event:** One normalized provider event from a Channel Adapter.
- **Conversation:** Ordered messages for one owner and channel session.
- **Conversation turn:** One revisioned message burst with one latest response target.
- **Agent run:** One bounded Bob-owned Pi turn over an immutable input snapshot.
- **External action attempt:** One durable attempt to change state or call an external system.
- **Context pack:** Confirmed and policy-cleared data supplied to one agent run.
- **Tool command:** One typed request from Bob's Pi loop to an owning Capability Module.
- **Capability Module:** One statically registered group of Tool definitions, execution Adapters, and safety metadata.
- **General Agent Core:** Domain-neutral Modules for conversation, the Pi harness, retrieval, memory, planning, policy, action evidence, and delivery.
- **Vertical Module:** One optional domain-owned set of capability, Context source, workflow, storage, route, and schedule Implementations.
- **Deployment profile:** One reviewed, immutable composition of the core profile and Vertical Modules for a release.
- **Core profile:** The minimum deployment profile. It contains the General Agent Core and no Vertical Module.
- **Runtime profile:** One static composition of Tool, evidence, conversation, route, schedule, and delivery target Adapters.
- **Capability catalogue:** The complete reviewed model tools selected by one deployment profile.
- **Capability catalogue generation:** The deterministic content identity of one deployment profile and its Capability catalogue.
- **Context source Module:** One statically registered source of candidate items selected by a deployment profile for a Context pack.
- **Retrieval pipeline:** Indexing, candidate retrieval, relevance checks, conflict handling, and bounded reading.
- **Owner memory:** Confirmed owner facts, preferences, corrections, and personal episodes.
- **Agent experience:** Reviewed evidence about workflows, environment behavior, outcomes, and recurring failures.
- **Health observation:** One read-only, content-free event sent through a fail-open telemetry seam.
- **Plan artifact:** One reusable structured draft for any owner planning task.
- **Agent run operation:** One completed model call, Tool call, or final output in an Agent run.
- **Agent run checkpoint:** One durable Agent run operation and its position in the ordered replay log.
- **Executable workflow step:** One stable, deterministic workflow action with explicit retry and completion rules. It is not a Plan artifact item.
- **Short reply binding:** An expiring link from one reply to one pending action.
- **Memory candidate:** An unconfirmed proposed fact revision.
- **Fact:** Stable identity for one durable personal claim.
- **Fact revision:** One append-only value and validity period for a fact.
- **Evidence:** A link from one fact revision to one or more source records.
- **Episode:** One dated event, activity, or interaction.
- **Skill:** Reviewed instructions that do not add tool permission.
- **Reminder:** One schedule and the owner's intent.
- **Reminder occurrence:** One due instance of a reminder.
- **Delivery attempt:** One local attempt to contact a provider.
- **Delivery recovery:** A bounded decision that restores a safe delivery or raises an operational alert.
- **Scheduled recovery:** Independent repair phases that continue after one item fails.
- **Production release:** One immutable bundle of a reviewed source revision, configuration revision, and runtime artifacts.
- **Acknowledged:** The owner confirms seeing one reminder occurrence.
- **Completed:** The owner confirms finishing one task.
- **Snoozed:** One occurrence closes and a linked successor is created.
- **Journal entry:** A private, time-stamped record from the owner.
- **Routine:** An ordered training plan independent from one gym.
- **Workout session:** One dated performance of a routine.
- **Trusted helper:** A separate person with explicit, revocable scopes.
- **Connections Gateway:** The shared application data-plane Module that gives one Bob Instance scoped access to external connections.
- **Instance identity:** The verified workload identity that selects one Bob Instance at the Connections Gateway.
- **Managed Account:** One application-plane account that can own one Bob Instance.
- **Provisioning subject:** One opaque Managed Account reference sent to the Control Plane.
- **Managed Channel Router:** The application data-plane Module that maps an authorized sender to one Bob Instance.
- **Staged channel event:** One durable authorized event that waits for its Bob Instance to become ready.
- **Job Queue:** Durable job publication and attempts behind a provider-neutral Interface.
- **Application Storage:** Durable relational records and atomic changes behind a provider-neutral Interface.
- **Object Storage:** Private objects behind a provider-neutral Interface.
- **Run Coordinator:** Owner-run ordering and delayed wake coordination behind a provider-neutral Interface.
- **Scheduler:** Periodic work and recovery triggers behind a provider-neutral Interface.
- **Runtime Adapter:** One hosting-specific Implementation of a Runtime Interface.

## System invariants

- Application Storage is authoritative for application records. The primary Runtime uses PostgreSQL.
- `packages/db` owns all Drizzle schemas, the PostgreSQL connection, migrations, and Better Auth storage.
- Better Auth owns the `auth_user`, `auth_session`, `auth_account`, `auth_verification`, and `auth_rate_limit` tables.
- A one-time setup token protects owner setup in the primary Runtime.
- Better Auth sessions protect owner API routes.
- The owner record is authoritative for live locality settings.
- A locality change affects new requests. An installed scheduling Module keeps saved schedules stable.
- Run Coordinator coordinates run order and installed scheduled wake-ups through Redis jobs.
- Run Coordinator state is not authoritative application data.
- Bob's Pi loop owns the single model and tool loop policy.
- Pi permanently owns provider streaming, model normalization, and OAuth support.
- One agent run uses one immutable context pack.
- One agent run uses one immutable conversation-turn revision.
- The latest message in a conversation-turn revision is its response target.
- A receipt-backed reflection can add one internal revision without a new message.
- The run attempt and reflection revision change in one atomic Application Storage operation.
- A transient Agent Runtime failure releases the same run revision for bounded checkpoint replay.
- Only the current turn revision can commit and deliver its reply.
- The Core Runtime enforces cross-capability invariants. Each Capability Module enforces its own invariants.
- Every agent run in one deployment profile receives the same reviewed capability catalogue.
- Every Tool belongs to exactly one statically registered Capability Module.
- The capability catalogue and its safety metadata produce one deterministic generation.
- Each new agent run records that generation. Core and Agent must agree before model execution.
- Context source Modules form one complete, ordered, static registry for each deployment profile.
- ContextStore owns source precedence, deduplication, budgets, and final Context pack assembly.
- The Retrieval pipeline owns its index, relevance threshold, temporal validity, conflict grouping,
  typed abstention, and whole-record reading budget.
- Context assembly never slices a recalled claim or splits one unresolved conflict group.
- Runtime discovery, package installation, or mutable hooks cannot add capability or authority.
- Message wording does not grant Tool authority. Owning Capability Modules enforce each action invariant.
- The agent never calls Sendblue directly.
- A Bob Instance never receives a shared Nango environment secret.
- One managed Owner runs in one Bob Instance.
- The Managed Channel Router stores sender mappings and Staged channel events outside the Control Plane.
- Unknown or unauthorized senders do not start provisioning.
- A managed Warm Sandbox contains no Owner state, credentials, storage, messages, or Secret Projection.
- Managed production Cloudflare changes belong to `teampitch-ops`.
- Managed production release identities and GitHub environments belong to the private Control Plane.
- Each Runtime Adapter passes the same conformance tests before promotion.
- One Bob Instance uses one authoritative Runtime Adapter set at a time.
- The Connections Gateway derives Instance scope from verified Instance identity.
- The Connections Gateway namespaces every Nango owner reference with the Bob Instance ID.
- The Sendblue modules never receive Pi OAuth credentials.
- OpenBao is authoritative for production configuration and credentials.
- Varlock defines and validates each runnable workspace's environment surface.
- Varlock resolves approved OpenBao values without owning them.
- Every Bob production record uses the `ops/apps/prod/bob` prefix.
- Local checks use explicit fixtures. They do not define a deployable environment.
- Secret values never enter committed environment files.
- No Cloudflare resource has two infrastructure owners.
- Health observation is read-only, content-free, validated, and fail-open.
- Effect composes I/O. Pure domain rules stay as normal TypeScript.
- Drizzle owns application schemas and queries. Better Auth uses the selected Application Storage Adapter for auth tables.
- Drizzle schemas and queries stay with their owning domain modules.
- Each Application Storage Adapter preserves the reviewed atomic-write behavior.
- Every mutating tool uses database idempotency.
- Deterministic channel commands run outside Pi.
- Only confirmed and model-eligible facts enter context packs.
- Each recalled personal fact includes a source label.
- Raw private records from an installed journal Module do not enter Pi.
- Recent conversation context contains only bounded delivered same-channel turns.
- An installed private-record Module can exclude its turns from recent conversation context.
- Memory extraction creates candidates. It never confirms them.
- Skills require review and cannot grant new tools.
- Installed scheduling workflows run outside the model.
- Delivery does not imply acknowledgment or completion.
- A provider timeout does not cause an automatic duplicate send.
- A delivery claim and its first attempt enter Application Storage in one atomic operation.
- An exhausted outbound queue item gets a bounded recovery decision.
- One scheduled recovery failure does not stop unrelated recovery work.
