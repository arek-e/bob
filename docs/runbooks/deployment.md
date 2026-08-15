# Production deployment

Status: active
Runtime authority: protected GitHub release workflow and Coolify

Use this runbook for Bob production releases.

## Release flow

A successful `main` CI run starts the protected `Release Runtime` workflow.

The workflow performs these actions:

1. Confirm that the successful commit is still the tip of `main`.
2. Build and attest the Agent and backup images.
3. Create one canonical OCI release bundle.
4. Verify the bundle and every image digest.
5. Read a short-lived Coolify credential from OpenBao.
6. Update the reviewed Runtime image pins.
7. Deploy the exact source revision through Coolify.
8. Check authenticated Agent readiness.

The workflow does not make a source commit. Coolify stores deployment history. The OCI bundle
stores immutable release identity.

Set `BOB_AUTO_RELEASE_ENABLED` to `true` to release each green `main` commit. Leave it unset to stop
automatic production releases.

## Promotion boundary

The workflow changes only these Coolify values:

- the source revision;
- the Agent image digest;
- the backup image digest;
- the Tunnel image digest;
- the observer image digest.

Coolify records the deployment. The workflow checks that Coolify used the exact source revision.

If deployment fails, the workflow restores the prior image pins and starts a rollback deployment.

The protected `production` environment controls access. OpenBao accepts only the reviewed GitHub
OIDC subject. It grants read access to the Coolify token and Agent readiness identity.

Do not store the Coolify token in GitHub.

## Manual artifact build

Start from a clean commit on `main`.

```sh
export RELEASE_SHA="$(git rev-parse HEAD)"
pnpm install --frozen-lockfile
pnpm check
pnpm secrets:scan:trusted
node scripts/verify-deployment-readiness.mjs
gh workflow run release-images.yml --ref main -f release_sha="$RELEASE_SHA"
```

The image workflow publishes these immutable references:

- `ghcr.io/arek-e/bob-agent:sha-$RELEASE_SHA`
- `ghcr.io/arek-e/bob-data-backup:sha-$RELEASE_SHA`
- `ghcr.io/arek-e/bob-release:sha-$RELEASE_SHA`

Do not commit generated release data to the Runtime source branch.

## Verify readiness

Keep `/health` as the public liveness check.

Call `/v1/admin/readiness` through the admin Cloudflare Access policy.

Require HTTP 200. Require `credentials` and `core` to report `ready`.

Run one safe inbound message from the allowed number. Require one accepted outbound result and one
terminal provider status.

Run the Coolify backup task once. Require `independentCopy` to report `completed`.

Confirm that the latest Bob backup age is below 18,000 seconds.

## Keep Cloudflare ownership separate

Do not apply Runtime Alchemy in production.

`teampitch-ops` OpenTofu owns Cloudflare resources and Tunnel configuration.

## Observe

Observe delivery errors, queue depth, Agent failures, and enabled Vertical Module failures.

Keep the release under observation for at least 30 minutes.

Record the bundle digest, source revision, image digests, deployment ID, and backup result.

## Roll back

The release script restores the prior image pins after a failed deployment.

For a later rollback, select the prior immutable bundle and run the protected release workflow.

Do not retry an uncertain delivery during rollback. Reconcile provider status first.

Run `/v1/admin/readiness` and the backup freshness checks again.

Use [Incident recovery](incident-recovery.md) if the Runtime does not recover.
