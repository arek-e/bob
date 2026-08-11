# ADR 0004: Use Alchemy, Effect v4, and Drizzle v1 RC

- Status: Accepted for the feasibility slice
- Date: 2026-08-11
- Scope: Cloudflare infrastructure, effectful TypeScript, and D1 access

## Context

Bob uses TypeScript in Workers and a private Node service.

The project needs repeatable Cloudflare infrastructure and typed failure handling.

It also needs reviewable D1 schemas and migrations.

Alchemy v2 already uses Effect v4 and Drizzle v1 RC.

All three selected releases are prereleases.

Their APIs can change between updates.

## Reviewed versions

| Package                 | Exact version    | Role                      |
| ----------------------- | ---------------- | ------------------------- |
| `alchemy`               | `2.0.0-beta.70`  | Cloudflare infrastructure |
| `effect`                | `4.0.0-beta.107` | Typed I/O composition     |
| `@effect/platform-node` | `4.0.0-beta.107` | Node entrypoint support   |
| `@effect/opentelemetry` | `4.0.0-beta.107` | Node telemetry adapter    |
| `@effect/vitest`        | `4.0.0-beta.107` | Effect tests              |
| `drizzle-orm`           | `1.0.0-rc.4`     | D1 schema and queries     |
| `drizzle-kit`           | `1.0.0-rc.4`     | SQL migration generation  |

The Cloudflare infrastructure workspace uses Effect `4.0.0-beta.102`.

Alchemy `2.0.0-beta.70` fails with Effect `4.0.0-beta.107` at CLI load time.
It calls an API that beta.107 removed.

Pin this narrow exception for `effect`, all Alchemy Effect peers, and `@effect/vitest`.
Keep application workspaces on beta.107.
Keep both graphs in the root workspace and root lockfile.

The root dependency check enforces this exception.

No Effect v4 release candidate exists at this review date.

Use TypeScript 5.9 or newer with strict checks.

Pin every package to the exact version.

Do not use `next`, `beta`, `rc`, caret, or tilde ranges.

## Decision

### Alchemy

Use Alchemy for Bob-owned Cloudflare application infrastructure.

Alchemy owns these resources when Bob creates them:

- Workers and service bindings
- Queues, consumers, retry rules, and dead-letter Queues
- D1 databases and their migration application
- R2 buckets
- Durable Object bindings and migrations
- Cron Triggers
- Access applications and policies
- Domains and DNS records
- Vectorize indexes after the memory milestone

Use `infra/cloudflare/alchemy.run.ts` as the visible stack composition.

Use one Alchemy stage named `prod`.

Keep the reminder Cron active in production.

Enable Sendblue only after its live URLs and reconciliation checks are ready.

One tool owns each Cloudflare resource.

Do not let Wrangler, OpenTofu, and Alchemy manage the same resource.

Keep existing shared platform resources with their current owner.

Keep Kubernetes and OpenBao infrastructure outside Alchemy for the first release.

Alchemy has no native OpenBao provider.

Use the existing Kubernetes and OpenBao workflows for those resources.

Apply a retain policy to production D1, R2, and Queue resources.

Guard production against destroy commands.

Never run `alchemy unsafe nuke` for Bob.

Use explicit resource adoption and rename metadata.

Do not use global production adoption.

### Alchemy state and credentials

OpenBao remains the authority for Bob runtime and deployment credentials.

Resolve the scoped Cloudflare token through Varlock's OpenBao plugin.

Run Alchemy through `varlock run --inject vars --skip-cache --`.

Configure the Alchemy profile to read Cloudflare credentials from the environment.

Do not store a Cloudflare token in the Alchemy profile.

Do not use `varlock-wrangler` because Alchemy owns Worker deployment.

Use `Cloudflare.state()` with pinned Alchemy `2.0.0-beta.70`.

It creates `AlchemyStateStoreToken` and `StateStoreEncryptionKey` in Cloudflare Secrets Store.

Alchemy owns these state credentials.

Do not create `ALCHEMY_PASSWORD` or `ALCHEMY_STATE_TOKEN`.

Do not keep an active copy of either state credential in OpenBao.

Alchemy creates declared Access service tokens and Tunnel credentials.

Sync their runtime values to scoped OpenBao records after creation.

Use in-memory Alchemy state only for the offline compatibility fixture.

The fixture uses fake providers and cannot apply or delete resources.

Do not send secret values through unencrypted local state.

Production requires an encrypted remote state store and one deployment lock.

Alchemy's Cloudflare state store sends operational telemetry to an Alchemy relay.

Its `noTrack` option does not disable all state-store telemetry.

Complete a privacy review before production state uses that service.

Use a private state implementation if the review rejects that telemetry.

Disable optional CLI telemetry in every automated environment.

### Effect

Use Effect v4 for typed orchestration around I/O.

Effect does not define Bob's repository structure.

Keep pure domain calculations as normal TypeScript functions.

Create `Context.Service` values only for real I/O capabilities.

Keep each live `Layer` beside its Implementation.

Compose one visible application Layer in each `composition.ts` file.

Use Effect Schema at every untrusted runtime seam.

Use it for webhooks, Queue jobs, APIs, Pi tools, and stored JSON.

Do not duplicate Drizzle table schemas with Effect Schema.

Use typed errors for expected failures.

Use serialized tagged errors only when an error crosses a runtime seam.

Do not retain rejected personal input in schema error reports.

Use cancellation and timeouts for every remote request.

Retry only transient and idempotent operations.

Effect schedules are not durable schedulers.

Queues, D1, and Durable Object alarms keep durable workflow state.

Workers import core Effect only and use native platform APIs.

Workers must not import `@effect/platform-node`.

The Node agent host can use `@effect/platform-node`.

Keep Pi's stable Agent as the only conversational loop.

Effect wraps Pi adapters. It does not replace Pi's loop.

Do not use `effect/unstable/*` in the first release.

Do not add generic repositories, generic clients, or a shared services package.

### Drizzle

Use Drizzle as Bob's only relational schema and query mapper.

Use the standard `drizzle-orm/d1` adapter behind a local Effect service.

Do not use `drizzle-orm/effect-d1` in the first release.

Its current D1 transaction implementation throws.

Do not add `@effect/sql-d1` as a second database abstraction.

Keep each module's table schema, queries, and database errors together.

Do not expose Drizzle rows or query types through module Interfaces.

Configure Drizzle Kit to read `src/modules/**/schema.ts`.

Keep one ordered migration directory at `apps/core-worker/migrations`.

Run `drizzle-kit generate` to create SQL migrations.

Review and commit every generated migration before deployment.

Use custom SQL migrations for FTS5, triggers, and data changes.

Use parameterized SQL templates for FTS queries.

Alchemy is the only production migration applier.

Do not use `drizzle-kit push` in production.

Do not use callback transactions with D1.

Use Drizzle's D1 `batch` operation for atomic state and outbox writes.

Keep D1 as the source of truth.

Durable Object state stays small and rebuildable.

Do not copy application tables into Durable Object SQLite.

### Tests and upgrades

Use `@effect/vitest` for Effect unit tests.

Use Cloudflare's Vitest pool for Worker and D1 integration tests.

Apply the committed migration set before each D1 integration suite.

The current Cloudflare migration test helper does not read nested RC folders.

Use a small recursive loader until Cloudflare fixes that limitation.

Test D1 batch rollback, outbox atomicity, FTS, and migration order.

Add one compatibility smoke test for Alchemy, Effect, Drizzle, and workerd.

Run `pnpm infra:load` in every CI run.
Run the Alchemy plan in trusted CI with scoped OpenBao credentials.
Do not allow either check to continue after failure.

Upgrade the prerelease stack in one grouped change.

An upgrade must pass type checks, tests, bundle checks, and an Alchemy plan.

Run all offline checks before each upgrade.

Review one production plan from the same commit before deployment.

## Consequences

Bob gets one TypeScript stack from infrastructure through application I/O.

Typed failure channels stay near the modules that own each operation.

SQL remains visible and reviewable.

Cloudflare resource ownership becomes explicit.

The prerelease stack needs exact pins and frequent compatibility checks.

Production deployment remains blocked until the Alchemy state privacy review finishes.

## Sources

- [Alchemy v2 review point](https://github.com/alchemy-run/alchemy/tree/941a0481c92540b6f44a088d531a24a3f4470317)
- [Alchemy providers](https://alchemy.run/providers/)
- [Alchemy state stores](https://alchemy.run/state-store/)
- [Alchemy privacy](https://alchemy.run/privacy/)
- [Alchemy D1](https://alchemy.run/providers/cloudflare/d1/database/)
- [Effect v4 beta review point](https://github.com/Effect-TS/effect/tree/3c495ae7c96d43bfc3b8020250562a194c2c895e)
- [Effect v4 services](https://github.com/Effect-TS/effect/blob/3c495ae7c96d43bfc3b8020250562a194c2c895e/migration/services.md)
- [Effect v4 migration guide](https://github.com/Effect-TS/effect/blob/3c495ae7c96d43bfc3b8020250562a194c2c895e/MIGRATION.md)
- [Drizzle v1 RC.4](https://github.com/drizzle-team/drizzle-orm/releases/tag/v1.0.0-rc.4)
- [Drizzle Cloudflare D1](https://orm.drizzle.team/docs/sqlite/connect-cloudflare-d1)
- [Drizzle migrations](https://orm.drizzle.team/docs/migrations)
- [Cloudflare D1 batch](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch)
- [Cloudflare D1 migration layout](https://developers.cloudflare.com/d1/reference/migrations/#nested-migration-layouts)
