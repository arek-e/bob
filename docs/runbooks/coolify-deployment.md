# Coolify private runtime

Status: active
Authority: Coolify

Coolify owns the agent, Tunnel, Nango, backup runner, observer, and backup task.

`infra/coolify/compose.yaml` owns the service model.

`infra/coolify/release.json` owns source and image pins.

`infra/coolify/runtime-contract.json` owns scheduled task and readiness requirements.

## Create the application

Create one Git-based Docker Compose application.

Use `infra/coolify/compose.yaml` from the reviewed deployment commit.

Do not publish a host port.

Do not assign a proxy domain to a Compose service.

Route public traffic only through the scoped Cloudflare Tunnel.

## Configure OpenBao

Apply `infra/openbao/agent-production-policy.hcl` as `bob-agent-production`.

Enable AppRole once.

```sh
bao auth enable approle
```

Create the agent role.

```sh
bao write auth/approle/role/bob-coolify-agent \
  token_policies=bob-agent-production \
  token_ttl=1h \
  token_max_ttl=4h \
  secret_id_ttl=720h \
  secret_id_num_uses=0
```

Store the role ID as `BAO_APPROLE_ROLE_ID`.

Store the secret ID as the Coolify secret source `BAO_APPROLE_SECRET_ID`.

The one-shot `agent-secret-init` service copies it into `/run/bob-agent-secrets`.

The guest stores `/run` in tmpfs. The read-only agent mounts that directory at `/run/secrets`.

The agent container does not receive it as an environment value.

Rotate the secret ID every 30 days or after suspected exposure.

## Configure Nango

Create one private PostgreSQL database.

Disable its public port.

Configure its S3 backup every four hours.

Require one successful backup before production traffic.

## Configure Bob backups

Create this task on `backup-runner`:

```sh
node ../../node_modules/varlock/bin/cli.js run --inject blob --skip-cache -- node dist/index.mjs backup
```

Use `15 */4 * * *`.

Enable Coolify failure notifications.

Compare both values to `infra/coolify/runtime-contract.json`.

Run the task once.

Require `independentCopy` to report `completed`.

Require the newest backup age to stay below 18,000 seconds.

## Release preflight

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm secrets:scan:trusted
node scripts/verify-deployment-readiness.mjs
```

The repository check proves the declared schedule.

The release operator must also prove the live Coolify task matches it.

## Acceptance

Require all Compose services to be healthy.

Call the authenticated agent route `/v1/admin/readiness`.

Require `credentials` and `core` to report `ready`.

Run one inbound and outbound acceptance message.

Run one backup and verify the independent copy.

## Recovery

Recreate the application from the reviewed Compose and release files.

Recreate the backup task from the runtime contract.

Restore Nango and Bob from the latest independent copies.

The shared host and Cloudflare account remain accepted failure domains.
