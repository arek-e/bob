# Coolify deployment contract

This file defines the public Runtime contract. The private Control Plane owns
managed production settings and the Coolify host.

## Source and images

Use one reviewed Runtime commit for the Compose file and the application code.
Publish the agent and backup images from that commit. Use their registry
digests. Pin the Cloudflared, Nango, and Redis images by digest as well.

The private release workflow must verify each digest before deployment.

## Services

`infra/coolify/compose.yaml` defines five services:

- `agent` listens on port `8787` inside the Compose network.
- `cloudflared` connects the private edge tunnel to the network.
- `nango` listens on ports `3003` and `3009` inside the network.
- `redis` provides Nango’s ephemeral queue store.
- `backup-runner` writes encrypted files to `bob-backups`.

The file does not publish host ports. The edge layer owns DNS and Access.

## Required configuration

Coolify must provide the environment values in the Compose file. These include
the release SHA, OpenBao AppRole credentials, Core Access credentials, tunnel
token, Nango database values, image digests, and backup values.

Do not commit values for these fields. The private Control Plane writes the
managed Access and tunnel records into OpenBao.

## Readiness

Run the static contract check and Compose model check.

```sh
pnpm coolify:check
docker compose -f infra/coolify/compose.yaml config --quiet
```

Then check `/health` for the agent and Core. Run one provider connection smoke
test and one backup verification before accepting traffic.

## Rollback

Select the previous Runtime SHA and all previous image digests. Keep the data
schema compatible. Run the same readiness and smoke checks after rollback.
