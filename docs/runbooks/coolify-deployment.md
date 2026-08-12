# Coolify deployment runbook

This runbook migrates Bob's private application runtime to Coolify.

Use `bob-production-ops` and `deploy-bob-coolify` together.

Do not deploy from a dirty worktree.

## Target topology

| Resource                                           | Owner                       | Location                                    |
| -------------------------------------------------- | --------------------------- | ------------------------------------------- |
| Core, UI, Queues, D1, and R2                       | Alchemy                     | Cloudflare                                  |
| Agent, Tunnel, Nango, Redis, and Bob backup runner | Coolify Compose application | `bob-coolify` KVM guest on `teampitch-prod` |
| Nango PostgreSQL                                   | Coolify database            | `bob-coolify` KVM guest                     |
| Production configuration and credentials           | OpenBao                     | Kubernetes on `teampitch-prod`              |
| Tempo, Loki, and OTLP collector                    | Existing platform           | Kubernetes on `teampitch-prod`              |
| Coolify UI, API, and MCP                           | Coolify through Tailscale   | `bob-coolify` KVM guest                     |

## External prerequisites

Use the existing Hetzner server named `teampitch-prod`.

Require 12 free CPU threads, 12 GiB available memory, and 50 GiB available disk.

Use `infra/coolify/host/cloud-init.yaml` for the Ubuntu guest.

Use `infra/coolify/host/bob-coolify-vm.service` for the QEMU process.

Give the guest 4 vCPUs, 12 GiB memory, and a 50 GiB thin disk.

Keep ports 80 and 443 with Cilium on the host.

Bind guest SSH and Coolify port forwards to `127.0.0.1` only.

Forward OpenBao port 8200 and OTLP port 4318 through QEMU.

Update the forwards if either Kubernetes ClusterIP changes.

Expose the dashboard only through Tailscale Serve.

Keep Coolify automatic updates disabled in production.

Record and review each Coolify version upgrade.

## Install and secure Coolify

Install Coolify inside the guest only.

Follow the current official installation guide.

Set `DOCKER_ADDRESS_POOL_BASE=172.20.0.0/16` during installation.

Disable Coolify automatic updates.

Record the installed Coolify version in the operator record.

Create one `bob` project and one `production` environment.

Use the guest localhost server as the production server.

Enable the API and MCP server.

Create these API tokens:

- `bob-agent-read-deploy` with `read` and `deploy` permissions;
- `bob-bootstrap-admin` with `write` permission and a short expiry.

Do not grant `read:sensitive` to the deployment token.

Delete the bootstrap token after setup.

Serve ports 8000, 6001, and 6002 through Tailnet HTTPS endpoints.

Do not use Funnel or a public DNS record for the dashboard.

## Configure agent MCP access

Start from `.codex/coolify-mcp.toml.example`.

Copy its server block into the project or user Codex configuration.

Replace the example URL with the final Coolify MCP URL.

Set this value outside Git:

```sh
export COOLIFY_MCP_TOKEN='set-through-your-secret-manager'
```

Restart Codex after the MCP configuration changes.

Confirm `get_infrastructure_overview` works.

Confirm the token cannot read environment values.

Confirm a deployment action requests approval.

## Create the agent AppRole

Apply `infra/openbao/agent-production-policy.hcl` under the policy name `bob-agent-production`.

Enable AppRole once if the auth method is absent.

```sh
bao auth enable approle
```

Bind the role to the Coolify guest when routing permits it.

```sh
bao write auth/approle/role/bob-coolify-agent \
  token_policies=bob-agent-production \
  token_ttl=1h \
  token_max_ttl=4h \
  secret_id_ttl=720h \
  secret_id_num_uses=0
```

Read the role ID and create one secret ID through a trusted terminal.

Do not print either value into an agent transcript.

Store the role ID as `BAO_APPROLE_ROLE_ID` in Coolify.

Store the secret ID as `BAO_APPROLE_SECRET_ID` with show-once enabled.

Rotate the secret ID at least every 30 days.

## Create the Nango database

Create a standalone PostgreSQL database in the Coolify project.

Use `nango` for the database name and user.

Keep its public port disabled.

Record its internal host and port.

Configure an S3 backup every four hours.

Use the private `bob-nango-backup-prod` R2 bucket.

Use an Object Read and Write token scoped only to this bucket.

Use independent object storage and enable `backup_now`.

Require one successful backup before Nango receives production traffic.

Export the current Nango database with `pg_dump --format=custom`.

Import it into the Coolify database with `pg_restore`.

Compare row counts before and after the import.

## Create the Compose application

Create a Git-based Docker Compose application.

Use the Bob repository and `infra/coolify/compose.yaml`.

Use the reviewed GitOps commit, not a working branch.

Do not assign a Coolify proxy domain to any stack service.

Set every required environment key shown by Coolify.

Copy runtime secret values from OpenBao through a trusted administrator path.

Use the existing `access/*`, `nango/runtime`, `backup/runtime`, and `tunnel/agent-host` records.

Store the `BACKUP_COPY_*` fields in `ops/apps/prod/bob/backup/runtime`.

Set `NANGO_RECORDS_DATABASE_URL` to the internal Coolify database URL.

Use URL encoding for any password characters in that URL.

Set the two Bob image digest fields without an `@` prefix.

Set `BOB_RELEASE_SHA` to the full source commit for those images.

Set `BAO_ADDR=http://vault.lamb-bicolor.ts.net:8200`.

Set `OTEL_EXPORTER_OTLP_ENDPOINT=http://otel.lamb-bicolor.ts.net:4318`.

Configure the S3 fields for the encrypted Bob backup copy.

Use the private `bob-backup-prod` R2 bucket in the existing Cloudflare account.

Use an Object Read and Write token scoped only to this bucket.

Do not reuse the private-object read token or a bucket administration token.

Apply the repository lock configuration to both backup buckets after creation:

```sh
pnpm --filter @bob/cloudflare-infra exec wrangler r2 bucket lock set \
  bob-backup-prod --file r2-backup-lock.json --jurisdiction eu --force
pnpm --filter @bob/cloudflare-infra exec wrangler r2 bucket lock set \
  bob-nango-backup-prod --file r2-backup-lock.json --jurisdiction eu --force
```

Confirm each bucket has the 90-day lock before a backup job starts.

The lock protects objects from the runtime tokens.

The same Cloudflare account remains one accepted failure domain.

## Configure schedules

Create this task on the `backup-runner` container:

```sh
node ../../node_modules/varlock/bin/cli.js run --inject blob --skip-cache -- node dist/index.mjs backup
```

Use `15 */4 * * *` as its schedule.

Enable failure notifications for backups and scheduled tasks.

Run the task once before deployment acceptance.

Require a `completed` result with `independentCopy` set to `completed`.

Do not log archive contents or environment values.

## Release preflight

Run these commands from a clean release commit:

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm secrets:scan:trusted
node scripts/verify-deployment-readiness.mjs
```

Verify both image attestations.

```sh
gh attestation verify "oci://ghcr.io/arek-e/bob-agent@${AGENT_DIGEST}" --repo arek-e/bob
gh attestation verify "oci://ghcr.io/arek-e/bob-data-backup@${BACKUP_DIGEST}" --repo arek-e/bob
```

Run the skill preflight script.

```sh
/Users/alex/.codex/skills/deploy-bob-coolify/scripts/check-release.sh /Users/alex/projects/bob
```

Stop when any check fails.

## Parallel deployment

Create a separate canary Cloudflare Tunnel.

Use canary hostnames for the agent and Nango.

Alchemy owns the `AgentCanaryTunnel` and its four canary DNS records.

Read the canary Tunnel token from `ops/apps/prod/bob/tunnel/agent-host-canary`.

Read canary Access audiences from the two canary Access records.

Protect the agent canary hostnames with the existing service-token policies.

Give the canary Tunnel token to the Coolify stack.

Do not use the production Tunnel token yet.

Deploy the Compose application through Coolify MCP.

Wait for the deployment to finish.

Inspect capped deployment logs and current container logs.

Confirm the agent, Tunnel, Nango, Redis, and database are healthy.

Run the Nango connection checks through the canary hostname.

Run one Bob request through the canary agent hostname.

Confirm D1, Tempo, and Loki show the same workflow.

## Cutover

Use a quiet owner window.

Run fresh Nango and Bob backups.

Record the old Tunnel connector state and all old origin URLs.

Set these OpenBao configuration values for the Coolify connector:

```text
AGENT_ORIGIN_URL=http://agent:8787
NANGO_ORIGIN_URL=http://nango:3003
NANGO_CONNECT_ORIGIN_URL=http://nango:3009
```

Set `OTEL_ORIGIN_URL` to the private endpoint reachable from the Coolify host.

Run `pnpm infra:plan` and review every replacement.

Apply the Cloudflare change only after the plan is accepted.

Stop the Kubernetes production Tunnel connector.

Replace the Coolify canary Tunnel token with the production Tunnel token.

Restart only the Coolify Tunnel service.

Do not stop the old agent or Nango yet.

## Acceptance

Send the exact owner request `List my reminders.`.

Confirm one successful request in D1, Tempo, and Loki.

Confirm Nango callbacks use the production hostnames.

Confirm the latest Nango backup exists in its locked R2 bucket.

Confirm the latest Bob archive exists in its locked R2 bucket.

Keep the Kubernetes runtime ready for rollback during the observation window.

## Rollback

Stop the Coolify production Tunnel connector.

Restore the old Cloudflare origin values through an accepted Alchemy plan.

Start the Kubernetes production Tunnel connector.

Verify the stable agent and Nango hostnames.

Do not restore PostgreSQL unless the Nango data check requires it.

Preserve failed Coolify deployment logs without secret values.

Delete the canary Tunnel after the rollback or successful observation window.
