# Production deployment

Status: active
Runtime authority: Coolify

Use this runbook for Bob production releases.

## Prepare the source release

Start from a clean commit on `main`.

```sh
export RELEASE_SHA="$(git rev-parse HEAD)"
pnpm install --frozen-lockfile
pnpm check
pnpm secrets:scan:trusted
node scripts/verify-deployment-readiness.mjs
```

The image workflow publishes these immutable images:

- `ghcr.io/arek-e/bob-agent:sha-$RELEASE_SHA`
- `ghcr.io/arek-e/bob-data-backup:sha-$RELEASE_SHA`

Read each manifest digest from the registry.

## Create the deployment commit

Change only these values in `infra/coolify/release.json`:

- `sourceSha`
- `agentDigest`
- `backupDigest`

Set `sourceSha` to `RELEASE_SHA`.

Commit the manifest change on `main`.

```sh
export DEPLOYMENT_SHA="$(git rev-parse HEAD)"
gh workflow run release-gate.yml --ref main \
  -f source_sha="$RELEASE_SHA" \
  -f deployment_sha="$DEPLOYMENT_SHA"
```

The gate permits only the three release values between both commits.

The gate also binds both registry digests to `RELEASE_SHA`.

## Apply the release

Open the production Compose application in Coolify.

Select `DEPLOYMENT_SHA` as the Git revision.

Set these application values from `infra/coolify/release.json`:

- `BOB_RELEASE_SHA`
- `BOB_AGENT_IMAGE_DIGEST`
- `BOB_BACKUP_IMAGE_DIGEST`

Deploy the application.

Do not change the Compose model during this action.

Wait for the agent, Tunnel, Nango, backup runner, and observer to become healthy.

## Verify readiness

Keep `/health` as the public liveness check.

Call `/v1/admin/readiness` through the admin Cloudflare Access policy.

Require HTTP 200 and both checks to report `ready`.

This check proves that the agent can read its OAuth record and reach Core.

Run one synthetic inbound message through the canary number.

Require one accepted outbound result and one linked provider status.

Run the Coolify backup task once.

Require `independentCopy` to report `completed`.

Confirm that the latest Bob and Nango backup age is below 18,000 seconds.

## Apply the Cloudflare plan

Use the plan from the successful release gate.

Set the same source revision before the trusted apply.

```sh
export BOB_RELEASE_SHA="$RELEASE_SHA"
```

Apply only that reviewed plan.

Do not copy the Worker OTLP token to OpenBao.

The Worker uses its scoped Cloudflare Access token.

The protected endpoint is:

```sh
OTLP_URL="https://bob-otel.${BOB_DOMAIN}"
```

## Observe

Observe delivery errors, queue depth, reminder misses, and agent failures.

Keep the release under observation for at least 30 minutes.

Record the source SHA, deployment SHA, image digests, and backup result.

## Roll back

Select the last healthy Coolify deployment.

Restore its three release values and deploy it.

Do not retry an uncertain delivery during rollback.

Reconcile provider status first.

Run `/v1/admin/readiness` and the backup freshness checks again.

Use [Incident recovery](incident-recovery.md) if the runtime does not recover.
