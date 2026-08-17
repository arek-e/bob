# Shared Runtime Cluster

This directory is the portable production contract for one shared Runtime Cluster.

The Runtime publishes these files in one immutable OCI artifact. The Control Plane Runner verifies every digest before Docker access.

The cluster runs one Core, one Channel, PostgreSQL, Redis, telemetry, and one scalable Agent Worker pool. PostgreSQL is authoritative. Redis stores pointer-only wake signals.

The Runner creates `bob-runtime-ingress`. Only Core and Channel join it. Agent Workers, PostgreSQL, Redis, and telemetry stay on the internal network.

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
