# Shared Runtime Cluster

This directory is the portable production contract for one shared Runtime Cluster.

The Runtime publishes these files in one immutable OCI artifact. The Control Plane Runner verifies every digest before Docker access.

The cluster runs one Core, one Channel, PostgreSQL, Redis, telemetry, and one scalable Agent Worker pool. PostgreSQL is authoritative. Redis stores pointer-only wake signals.

The Runner creates `bob-runtime-ingress`. Only Core and Channel join it. Agent Workers, PostgreSQL, Redis, and telemetry stay on the internal network.

## Production data inspection

Coolify and the Control Plane manage deployment and Runtime metadata. PostgreSQL remains the application data
authority. Do not use Coolify resource inspection as a substitute for a database read.

The Core environment projection must contain `PRODUCTION_DATA_INSPECTOR_SECRET` from OpenBao. The value must be
at least 32 characters and must be projected to the `core` consumer only.

The operator-only Runtime endpoints are:

- `GET /internal/production-data/summary?from=<iso>&to=<iso>&limit=<1-100>`
- `GET /internal/production-data/workflow/<correlation-id>?limit=<1-100>`

Send the caller token in `x-bob-caller-token`. The endpoints return bounded metadata. They do not return message
ciphertext, private Agent payloads, provider handles, or arbitrary SQL results.

The repository helpers `pnpm maint summarize-activity` and `pnpm maint inspect-workflow` call these endpoints. Set the token through a
secret-safe environment provider such as `PRODUCTION_DATA_INSPECTOR_TOKEN`; do not pass it as a command-line
argument.

Message text is available through `pnpm maint read-latest-messages` or directly at
`GET /api/production-data/messages` with the existing Better Auth owner session. The endpoint applies the same
bounded window and limit rules. An operator token cannot access it.

## Release order

1. Pull and verify the release bundle.
2. Resolve exact OpenBao secret versions.
3. Run the one-shot migration.
4. Reconcile singleton services and Agent Worker replicas.
5. Run an encrypted backup.
6. Restore that backup into isolated PostgreSQL.
7. Observe the release for 30 minutes.

## Recovery objectives

The Control Plane requests a verified backup every four hours. The target recovery point is four hours.

Each backup includes PostgreSQL and encrypted Object Storage. Restic applies daily, weekly, and monthly retention.

The restore verifier restores the newest snapshot into isolated PostgreSQL. It checks snapshot hashes, restores the database, and reads an application table.

The target restore time is 60 minutes. Operators must test this target after host, storage, or database changes.

Redis uses AOF. A total Redis loss does not lose authoritative work. PostgreSQL outboxes reconstruct Agent Run and delivery wake signals.
