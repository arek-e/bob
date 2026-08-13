# Deployment runbook

Bob Runtime is the portable application repository. Bob Control Plane owns the
managed production account, Cloudflare edge, OpenBao policies, and Coolify host.

## Validate a release

Run these commands from the Runtime repository root.

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm secrets:scan:staged
node scripts/verify-deployment-readiness.mjs
```

The release SHA must be a full commit on `main`.

```sh
RELEASE_SHA="$(git rev-parse HEAD)"
git merge-base --is-ancestor "$RELEASE_SHA" origin/main
gh workflow run release-images.yml --ref main -f release_sha="$RELEASE_SHA"
```

The image workflow publishes and attests the agent and backup images. Record
their immutable digests in the private Control Plane release record.

## Deploy a managed instance

The private Control Plane selects the Runtime SHA and image digests. It checks
the Runtime Compose contract, plans Cloudflare resources, and deploys through
Coolify.

The managed deployment uses these services:

- `agent` for the private Node runtime.
- `cloudflared` for the private edge tunnel.
- `nango` and `redis` for provider connections.
- `backup-runner` for scheduled encrypted backups.

The Compose file has no host ports. The edge tunnel reaches services on the
private Compose network. Cloudflare DNS and Access remain private Control
Plane resources.

## Self-host the Runtime

Copy `infra/coolify/compose.yaml` into a Coolify project. Set every required
variable in the Coolify environment. Use only image digests.

OpenBao must provide AppRole credentials for the agent. The private Control
Plane writes the Access records and tunnel token for its managed instance.

Do not commit environment values, credentials, tunnel tokens, or database URLs.

## Verify the running services

Check the agent health endpoint from the Compose network.

```sh
docker compose -f infra/coolify/compose.yaml exec agent \
  node --input-type=module -e \
  'const r = await fetch("http://127.0.0.1:8787/health"); if (!r.ok) process.exit(1)'
```

Check the stable Core URL through the managed edge. Do not use a temporary
`workers.dev` URL for `CORE_URL`.

```sh
curl -fsS "$CORE_URL/health" >/dev/null
```

Check backup output after the first scheduled run. Use the backup restore
runbook for a recovery drill.

## Roll back

Roll back by selecting the previous Runtime SHA and its image digests in the
private Control Plane release record. Keep additive database migrations.

Do not replace an image digest with a mutable tag. Re-run the readiness check
before the Control Plane plans the rollback.
