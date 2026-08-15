# Production deployment

Status: active
Runtime authority: Bob Control Plane

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
- `ghcr.io/arek-e/bob-release:sha-$RELEASE_SHA`

The last image is an OCI release bundle. It binds the source, configuration, deployment contract, and all image digests.

```sh
gh workflow run release-images.yml --ref main -f release_sha="$RELEASE_SHA"
```

Read the immutable bundle reference from the completed workflow summary.

```sh
export BUNDLE_REFERENCE="ghcr.io/arek-e/bob-release@sha256:<digest>"
```

Do not commit generated release data to the Runtime source branch.

## Apply the release

Request the durable release through the Bob Control Plane workflow.

Production validation and deployment run only in the private Control Plane.

```sh
gh workflow run release.yml -R arek-e/bob-control-plane --ref main \
  -f bundle_reference="$BUNDLE_REFERENCE" \
  -f deploy=true
```

The Control Plane pulls and validates the exact OCI bundle.

It verifies the image digests and build provenance against the bundle source revision.

The Control Plane promotes the exact bundle digest and records the durable Operation.

The assigned Bob Runner applies the reviewed contract. Independent assurance records acceptance.

Coolify can host the initial Compose target. It is not part of the orchestration Interface.

Wait for the agent, Tunnel, backup runner, and observer to become healthy.

## Automatic release preparation

`.github/workflows/auto-release.yml` prepares artifacts after successful `main` CI runs.

Set `BOB_RELEASE_PREPARATION_ENABLED` to `true` to prepare each green `main` commit.

The public workflow performs these actions:

1. Confirm that the successful commit is still the tip of `main`.
2. Build and attest both Runtime images.
3. Create one canonical release bundle.
4. Publish the bundle to GHCR by immutable digest.

The workflow does not write to `main`.

It does not use a production environment, production identity, private network, or Control Plane endpoint.

Dispatch the private Control Plane workflow when these checks pass:

- The shared Connections Gateway is healthy.
- Existing Nango connections use Instance-scoped owner references.
- The target Bob Runner is enrolled and assigned.
- The Runner can report observations without changing Runtime state.
- A canary release completed independent assurance.

Leave the variable unset to require manual artifact preparation.

The private Control Plane verifies the bundle, image digests, provenance, Runtime checks, and production plan.

Do not give either repository a Coolify administrator token.

## Verify readiness

Keep `/health` as the public liveness check.

Call `/v1/admin/readiness` through the admin Cloudflare Access policy.

Require HTTP 200 and both checks to report `ready`.

Run one synthetic inbound message through the canary number.

Require one accepted outbound result and one linked provider status.

Run the Coolify backup task once.

Require `independentCopy` to report `completed`.

Confirm that the latest Bob backup age is below 18,000 seconds.

## Keep Cloudflare ownership separate

Do not apply Runtime Alchemy in production.

`teampitch-ops` OpenTofu owns Cloudflare resources and Tunnel configuration.

## Observe

Observe delivery errors, queue depth, Agent failures, and enabled Vertical Module failures.

Keep the release under observation for at least 30 minutes.

Record the bundle digest, source revision, image digests, and backup result.

## Roll back

Request rollback through the Bob Control Plane.

It selects the previous accepted Runtime release bundle and records the result.

Do not retry an uncertain delivery during rollback.

Reconcile provider status first.

Run `/v1/admin/readiness` and the backup freshness checks again.

Use [Incident recovery](incident-recovery.md) if the runtime does not recover.
