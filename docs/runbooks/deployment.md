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

```sh
gh workflow run release-images.yml --ref main -f release_sha="$RELEASE_SHA"
```

## Create the deployment commit

Change only these values in `infra/coolify/release.json`:

- `sourceSha`
- `agentDigest`
- `backupDigest`

Set `sourceSha` to `RELEASE_SHA`.

Commit the manifest change on `main`.

```sh
export DEPLOYMENT_SHA="$(git rev-parse HEAD)"
node scripts/verify-release-manifest-delta.mjs "$RELEASE_SHA" "$DEPLOYMENT_SHA"
```

The private Control Plane gate permits only the three release values between both commits.

It also binds both registry digests to `RELEASE_SHA`.

## Apply the release

Request the durable release through the Bob Control Plane workflow.

Production validation and deployment run only in the private Control Plane.

```sh
gh workflow run release.yml -R arek-e/bob-control-plane --ref main \
  -f source_sha="$RELEASE_SHA" \
  -f deployment_sha="$DEPLOYMENT_SHA" \
  -f deploy=true
```

The reviewed manifest supplies the agent, backup, Tunnel, and observer image digests.

The Control Plane selects `DEPLOYMENT_SHA` and verifies every immutable digest.

The assigned Bob Runner applies the reviewed contract. Independent assurance records acceptance.

Coolify can host the initial Compose target. It is not part of the orchestration Interface.

Wait for the agent, Tunnel, backup runner, and observer to become healthy.

## Automatic releases

`.github/workflows/auto-release.yml` prepares artifacts after successful `main` CI runs.

Set the repository variable `BOB_RELEASE_PREPARATION_ENABLED` to `true` when each green `main` commit must prepare release artifacts.

The public workflow performs these actions:

1. Confirm that the successful commit is still the tip of `main`.
2. Skip commits that change only `infra/coolify/release.json`.
3. Build and attest both immutable runtime images.
4. Commit only the three reviewed release values to `main`.

It does not use a production environment, production identity, private network, or Control Plane endpoint.

Dispatch the private Control Plane workflow when these checks pass:

- The shared Connections Gateway is healthy.
- Existing Nango connections use Instance-scoped owner references.
- The target Bob Runner is enrolled and assigned.
- The Runner can report observations without changing Runtime state.
- A canary release completed independent assurance.

Leave the variable unset to require manual image and manifest preparation.

Offline Runtime checks continue to run on every pull request and `main` push.

The private Control Plane verifies the release delta, image digests, provenance, Runtime checks, and production plan. It then requests and observes one durable release Operation.

Do not give either repository a Coolify administrator token.

## Verify readiness

Keep `/health` as the public liveness check.

Call `/v1/admin/readiness` through the admin Cloudflare Access policy.

Require HTTP 200 and both checks to report `ready`.

This check proves that the agent can read its OAuth record and reach Core.

Run one synthetic inbound message through the canary number.

Require one accepted outbound result and one linked provider status.

Run the Coolify backup task once.

Require `independentCopy` to report `completed`.

Confirm that the latest Bob backup age is below 18,000 seconds.

## Keep Cloudflare ownership separate

Do not apply Runtime Alchemy in production. `teampitch-ops` OpenTofu owns
Cloudflare resources and tunnel configuration. Use its reviewed change path
for Cloudflare updates.

## Observe

Observe delivery errors, queue depth, reminder misses, and agent failures.

Keep the release under observation for at least 30 minutes.

Record the source SHA, deployment SHA, image digests, and backup result.

## Roll back

Request rollback through the Bob Control Plane. It selects the previous
accepted Runtime Release and records the result.

Do not retry an uncertain delivery during rollback.

Reconcile provider status first.

Run `/v1/admin/readiness` and the backup freshness checks again.

Use [Incident recovery](incident-recovery.md) if the runtime does not recover.
