# Bob context

Status: product and architecture context  
Updated: 2026-08-12

## Product

Bob is a private continuity assistant for one owner.

The primary interface is iMessage through Sendblue.

Bob supports reminders, personal recall, gym routines, workouts, and private journals.

Bob helps a person who can have memory impairment.

Bob must stay simple, predictable, source-based, and easy to correct.

## Long-term vision

Bob aims to become a general personal continuity agent for one owner.

Bob is general in understanding and planning across day-to-day life.

Bob gains broad capability through reviewed domain tools and approved service connections.

Bob keeps explicit and bounded authority as its capability grows.

Bob uses iMessage as the stable conversation interface.

Bob uses the private UI for setup, review, recovery, and consequential approvals.

Bob learns owner preferences from explicit statements and corrections.

Bob does not silently promote inferred preferences into confirmed memory.

Bob can become proactive when a grounded signal shows a likely owner need.

Bob must limit unnecessary questions, actions, and interruptions.

Bob improves through measured outcomes, synthetic evaluations, reviewed changes, and controlled releases.

Bob does not rewrite its production policy or grant itself new authority.

The authority model follows these rules:

- Read approved data only when a request or approved proactive policy requires it.
- Execute a reversible change when owner intent and the target are clear.
- Ask before a consequential, ambiguous, externally visible, or hard-to-reverse change.
- Record the result of each external action and disclose an unknown result.
- Provide correction, cancellation, or undo when the domain supports it.
- Stop access when the owner revokes a connection or capability.

[Personal agent interaction research](docs/research/personal-agent-interaction.md) records the
research basis, public benchmarks, and proposed evaluation plan.

## Non-goals

Bob is not an emergency system.

Bob is not a medication-safety system.

Bob is not an unbounded computer-control agent.

Bob does not receive arbitrary access or authorize new capabilities for itself.

Bob is not a multi-user assistant in the first release.

Bob does not expose shell, browser, filesystem, or arbitrary MCP tools.

## Domain language

- **Owner:** The one person Bob serves.
- **Owner settings:** The owner's time zone, locale, time format, and connection summaries.
- **Channel event:** One normalized provider event from Sendblue.
- **Conversation:** Ordered messages for one owner and channel session.
- **Conversation turn:** One revisioned message burst with one latest response target.
- **Agent run:** One bounded Bob-owned Pi turn over an immutable input snapshot.
- **External action attempt:** One durable attempt to change state or call an external system.
- **Context pack:** Confirmed and policy-cleared data supplied to one agent run.
- **Tool command:** One typed request from Bob's Pi loop to a Bob domain module.
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
- **Runtime assurance:** Evidence that the private runtime, backups, and credentials meet the production contract.
- **Production release:** One reviewed source revision and its immutable runtime artifacts.
- **Acknowledged:** The owner confirms seeing one reminder occurrence.
- **Completed:** The owner confirms finishing one task.
- **Snoozed:** One occurrence closes and a linked successor is created.
- **Journal entry:** A private, time-stamped record from the owner.
- **Routine:** An ordered training plan independent from one gym.
- **Workout session:** One dated performance of a routine.
- **Trusted helper:** A separate person with explicit, revocable scopes.

## System invariants

- D1 is authoritative for application records.
- Better Auth owns the `auth_user`, `auth_session`, `auth_account`, `auth_verification`, and `auth_rate_limit` tables.
- Cloudflare Access protects only Core internal routes and the one-time owner setup route.
- Better Auth sessions protect owner API routes.
- The owner record is authoritative for live locality settings.
- A locality change affects new requests. Existing reminders keep their saved schedules.
- Durable Objects coordinate run order and reminder wake-ups.
- Durable Object state is not authoritative application data.
- Bob's Pi loop owns the single model and tool loop policy.
- Pi permanently owns provider streaming, model normalization, and OAuth support.
- One agent run uses one immutable context pack.
- One agent run uses one immutable conversation-turn revision.
- The latest message in a conversation-turn revision is its response target.
- A receipt-backed reflection can add one internal revision without a new message.
- The run attempt and reflection revision change in one D1 batch.
- Only the current turn revision can commit and deliver its reply.
- The core Worker enforces every domain invariant.
- The agent never calls Sendblue directly.
- The Sendblue modules never receive Pi OAuth credentials.
- OpenBao is authoritative for production configuration and credentials.
- Varlock defines and validates each runnable workspace's environment surface.
- Varlock resolves approved OpenBao values without owning them.
- Every Bob production record uses the `ops/apps/prod/bob` prefix.
- Local checks use explicit fixtures. They do not define a deployable environment.
- Secret values never enter committed environment files.
- Alchemy state credentials stay in Cloudflare Secrets Store.
- Alchemy owns each Bob Cloudflare resource that it declares.
- A separate D1 database stores continuous public benchmark run metadata.
- A separate private R2 bucket stores public or synthetic evaluation artifacts.
- A scheduled Cloudflare Worker runs the committed synthetic interaction gate each day.
- The evaluation Worker can access only the separate evaluation D1 database and R2 bucket.
- Production assistant Workers cannot access evaluation storage.
- Alchemy creates Access service tokens and Tunnel credentials before OpenBao receives their runtime copies.
- No Cloudflare resource has two infrastructure owners.
- Coolify and OpenBao stay outside Alchemy.
- Effect composes I/O. Pure domain rules stay as normal TypeScript.
- Drizzle owns application schemas and queries. Better Auth uses its built-in D1 adapter for auth tables.
- Drizzle schemas and queries stay with their owning domain modules.
- D1 atomic writes use batch operations, not callback transactions.
- Every mutating tool uses database idempotency.
- Deterministic channel commands run outside Pi.
- Only confirmed and model-eligible facts enter context packs.
- Each recalled personal fact includes a source label.
- Raw journal text does not enter Pi in the first release.
- Recent conversation context contains only bounded delivered same-channel turns.
- Journal-intent turns do not enter recent conversation context.
- Memory extraction creates candidates. It never confirms them.
- Skills require review and cannot grant new tools.
- Reminders run outside the model.
- Delivery does not imply acknowledgment or completion.
- A provider timeout does not cause an automatic duplicate send.
- A delivery claim and its first attempt enter D1 in one atomic batch.
- An exhausted outbound queue item gets a bounded recovery decision.
- One scheduled recovery failure does not stop unrelated recovery work.

## Decision index

- [Project plan](docs/PROJECT_PLAN.md)
- [Personal agent interaction research](docs/research/personal-agent-interaction.md)
- [ADR 0001: Pi OpenAI Codex authentication](docs/adr/0001-pi-openai-codex-auth.md)
- [ADR 0002: Durable Sendblue channel](docs/adr/0002-sendblue-agent-channel.md)
- [ADR 0003: Agent runtime and repository seams](docs/adr/0003-agent-runtime-and-repository-seams.md)
- [ADR 0004: Alchemy, Effect v4, and Drizzle v1 RC](docs/adr/0004-alchemy-effect-drizzle.md)
- [ADR 0005: Varlock environment contracts](docs/adr/0005-varlock-environment-contracts.md)
- [ADR 0007: Bob-owned Pi AI loop](docs/adr/0007-bob-owned-pi-ai-loop.md)
- [ADR 0009: Coolify private runtime](docs/adr/0009-coolify-private-runtime.md)
- [ADR 0010: Revisioned conversation turns](docs/adr/0010-revisioned-conversation-turns.md)
- [ADR 0011: Evaluation records and artifacts](docs/adr/0011-evaluation-storage.md)
