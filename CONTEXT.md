# Bob context

Status: product and architecture context  
Updated: 2026-08-12

## Product

Bob is a private continuity assistant for one owner.

The primary interface is iMessage through Sendblue.

Bob supports reminders, personal recall, gym routines, workouts, and private journals.

Bob helps a person who can have memory impairment.

Bob must stay simple, predictable, source-based, and easy to correct.

## Non-goals

Bob is not an emergency system.

Bob is not a medication-safety system.

Bob is not a general computer-control agent.

Bob is not a multi-user assistant in the first release.

Bob does not expose shell, browser, filesystem, or arbitrary MCP tools.

## Domain language

- **Owner:** The one person Bob serves.
- **Owner settings:** The owner's time zone, locale, time format, and connection summaries.
- **Channel event:** One normalized provider event from Sendblue.
- **Conversation:** Ordered messages for one owner and channel session.
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
- Memory extraction creates candidates. It never confirms them.
- Skills require review and cannot grant new tools.
- Reminders run outside the model.
- Delivery does not imply acknowledgment or completion.
- A provider timeout does not cause an automatic duplicate send.

## Decision index

- [Project plan](docs/PROJECT_PLAN.md)
- [ADR 0001: Pi OpenAI Codex authentication](docs/adr/0001-pi-openai-codex-auth.md)
- [ADR 0002: Durable Sendblue channel](docs/adr/0002-sendblue-agent-channel.md)
- [ADR 0003: Agent runtime and repository seams](docs/adr/0003-agent-runtime-and-repository-seams.md)
- [ADR 0004: Alchemy, Effect v4, and Drizzle v1 RC](docs/adr/0004-alchemy-effect-drizzle.md)
- [ADR 0005: Varlock environment contracts](docs/adr/0005-varlock-environment-contracts.md)
- [ADR 0007: Bob-owned Pi AI loop](docs/adr/0007-bob-owned-pi-ai-loop.md)
- [ADR 0009: Coolify private runtime](docs/adr/0009-coolify-private-runtime.md)
