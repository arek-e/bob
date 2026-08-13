# ADR 0005: Use Varlock for environment contracts

- Status: Accepted for the feasibility slice
- Date: 2026-08-11
- Scope: Environment schemas, OpenBao resolution, local commands, and deployment bootstrap

## Context

Bob has several deployables with different configuration and secret access.

Plain `.env` files would duplicate configuration and expose secrets to tools.

OpenBao already owns Bob's runtime and deployment secrets.

Alchemy already owns Bob's Cloudflare resources.

The project needs one typed and reviewable environment contract per deployable.

## Reviewed versions

| Package                           | Exact version | Role                                                |
| --------------------------------- | ------------- | --------------------------------------------------- |
| `varlock`                         | `1.16.1`      | Schema validation and command environment injection |
| `@varlock/hashicorp-vault-plugin` | `2.1.0`       | OpenBao KV v2 secret resolution                     |

Varlock requires Node.js 22 or newer.

Bob already requires Node.js 22.19 or newer.

Pin both packages to the exact versions.

Do not use caret, tilde, or moving tags.

## Decision

### Ownership

Use Varlock as Bob's environment schema and loading layer.

OpenBao remains the secret authority.

Varlock must not become a second secret store.

Alchemy remains the Cloudflare infrastructure authority.

Coolify is the portable Node runtime authority. The private Control Plane is the managed deployment authority.

### Schema layout

Give each runnable workspace one `.env.schema` beside its `package.json`.

Do not give environment-free workspaces a schema.

Keep only shared, non-sensitive defaults in the root schema.

Set `@defaultSensitive=true` and `@defaultRequired=true` in secret-bearing schemas.

Import shared keys with explicit `pick` lists.

Import the schema file, not its complete directory.

This prevents unrelated local overrides from crossing application boundaries.

Keep imports one-way and reject circular imports.

Generate package-local TypeScript accessors with `exposeEnv=local`.

Do not augment one global environment type across the monorepo.

### OpenBao resolution

Load `@varlock/hashicorp-vault-plugin@2.1.0` from each secret-bearing schema.

Use `BAO_ADDR` as non-sensitive bootstrap configuration.

Use the fixed OpenBao prefix `ops/apps/prod/bob`.

Load persistent deployment configuration from `ops/apps/prod/bob/config`.

Declare each field with `vaultSecret("config")` in the Cloudflare schema.

Do not define a deployment stage selector.

Do not map local or test values to another secret namespace.

Local validation supplies complete fixture values.

Local validation must not resolve production OpenBao records.

Set `@cache=disabled` and `cacheTtl=false` for deployment schemas.

Declare each consumed field explicitly.

Do not bulk-load a complete OpenBao record into every process.

Do not enable automatic creation of missing secret values.

Mark credentials, phone numbers, key material, and account identifiers as sensitive.

Approved local production commands can use the current OpenBao CLI token file.

Automation must use short-lived JWT authentication when the runner supports it.

Use a production-scoped AppRole only when JWT authentication is unavailable.

CI handoff uses GitHub OIDC when the runner can reach OpenBao.

Local handoff can use one 10-minute OpenBao child token.

Set that token only through the sensitive `BAO_DEPLOY_TOKEN` input.

Attach only the `bob-deployment-credential-handoff` policy.

The handoff must receive exactly one identity method.

It revokes its OpenBao token after the scoped writes.

Inject only the secret-zero authentication fields into the automation job.

Do not place OpenBao tokens in committed environment files.

Do not resolve Pi OAuth credentials into environment variables.

The Pi credential store continues to read its atomic provider record from OpenBao.

### Alchemy and Workers

Run Alchemy through `varlock run --inject vars --skip-cache --`.

Varlock validates and resolves the production contract before Alchemy starts.

The `--inject vars` option prevents injection of the complete resolved graph.

Alchemy passes each static Worker secret only to its declared consumer.

Do not use `varlock-wrangler deploy`.

It would create a second owner for Worker variables and secrets.

Do not import Varlock's Cloudflare runtime into Workers in the first release.

Do not install `@varlock/cloudflare-integration` in the first release.

Alchemy cannot currently create Varlock's `__VARLOCK_ENV` runtime binding.

Do not enable `nodejs_compat` only for Varlock.

Worker code reads typed Cloudflare bindings and validates them at its entrypoint.

### Node and local commands

Run the private agent through `varlock run --inject vars --skip-cache --`.

Varlock validates bootstrap configuration before the Node process starts.

The Node service uses AppRole authentication for portable runtime OpenBao access.

Do not fetch deployment credentials for each user request.

Do not use a disk cache for resolved production secrets.

Plain `.env.local` files can contain non-sensitive overrides only.

### Browser configuration

Never expose a sensitive item to browser code.

The UI schema must mark every client-visible item as non-sensitive.

The UI build fails when a required public item is absent or invalid.

### Agent and CI safety

Agents may read committed `.env.schema` files.

Agents must use `varlock load --agent` when they inspect resolved configuration.

Never put plain `varlock load` output in an agent transcript.

Run `varlock scan --staged` before commits.

Run a complete `varlock scan` in CI and after each client build.

Run this complete scan only in a trusted job with a scoped secret identity.

Untrusted pull requests validate non-sensitive items only.

Run `varlock audit` after application code exists.

Treat missing schema keys and unused sensitive keys as release failures.

Keep Varlock's default log redaction enabled for Node commands.

Never use `--include-internal`, `--no-redact-stdout`, or raw environment output in CI.

Commit `.varlock/config.json` with telemetry disabled.

Cloudflare code keeps Bob's existing content-free logging rules.

## Consequences

Each process receives a small and explicit configuration set.

Agents can understand configuration without receiving secret values.

OpenBao paths stay visible and reviewable without duplicating their contents.

The deployment adds one resolver step before Alchemy runs.

Worker runtime leak protection remains unavailable with Alchemy today.

Bob must keep its own Worker log and response safety tests.

## Sources

- [Varlock source](https://github.com/dmno-dev/varlock)
- [`varlock@1.16.1`](https://www.npmjs.com/package/varlock/v/1.16.1)
- [`@varlock/hashicorp-vault-plugin@2.1.0`](https://www.npmjs.com/package/@varlock/hashicorp-vault-plugin/v/2.1.0)
- [Varlock installation](https://varlock.dev/getting-started/installation/)
- [Varlock schemas](https://varlock.dev/guides/schema/)
- [Varlock monorepos](https://varlock.dev/guides/monorepos/)
- [Varlock AI tools](https://varlock.dev/guides/ai-tools/)
- [Varlock secrets](https://varlock.dev/guides/secrets/)
- [Varlock OpenBao plugin](https://varlock.dev/plugins/hashicorp-vault/)
- [Varlock Cloudflare integration](https://varlock.dev/integrations/cloudflare/)
