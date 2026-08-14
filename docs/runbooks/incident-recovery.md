# Incident recovery

Status: active
Runtime authority: Coolify

## First response

Stop a release if Bob cannot receive, reason, or send.

Record the source SHA and the Coolify deployment ID.

Check these signals in order:

1. Cloudflare Worker and Queue health.
2. Agent liveness at `/health`.
3. Agent readiness at `/v1/admin/readiness`.
4. Nango database health.
5. Backup task result and backup age.

Do not log message text, credentials, or archive contents.

## Delivery recovery

An exhausted outbound Queue item enters the Core delivery recovery path.

Core republishes only a pending outbox without a provider attempt.

Core limits this recovery to three decisions.

Core raises `outbound_exhausted` for the owner.

Never resend a claimed or uncertain outbox automatically.

## Inbound recovery

The egress Worker runs direct recovery every two minutes.

The Core Worker also calls the authenticated recovery endpoint on even UTC minutes.

D1 removes duplicate webhook and replay records.

## Uncertain delivery recovery

For `delivery_uncertain`, use the owner alert reconciliation action.

The action asks Sendblue for status when an attempt has a provider handle.

Warn the owner before any later manual retry.

## Runtime rollback

Request rollback through the Bob Control Plane.

The Control Plane selects the previous accepted Runtime Release.

Do not change Compose or Cloudflare resources during rollback.

Require the private readiness check to pass.

Then run one synthetic inbound and outbound check.

## Host loss

Recreate the Coolify application from `infra/coolify/compose.yaml`.

Use the reviewed values in `infra/coolify/release.json`.

Restore the AppRole secret through the Docker secret source.

Recreate the scheduled task from `infra/coolify/runtime-contract.json`.

Restore Nango from its latest independent copy.

Restore Bob data with [Backup and restore](backup-restore.md).

Run readiness and acceptance checks before the Tunnel receives traffic.

## Accepted limits

The private runtime, OpenBao, telemetry, and local backup share one physical host.

Source data and backup copies share one Cloudflare account.

Current recovery does not cover a Cloudflare account loss or a Cloudflare-wide event.
