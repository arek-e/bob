# Backup and restore runbook

## Targets

Use a four-hour recovery point objective. Use a one-day recovery time objective initially.

Store one encrypted backup outside the Cloudflare account.

D1 Time Travel is not an independent backup.

## Backup

Pause writes or record a consistent cutoff time. Export primary tables only.

Export private R2 objects as encrypted bytes. Record each key version and content hash.

Encrypt the backup manifest. Store its checksum separately.

## Restore test

Restore into isolated disposable fixture storage. This storage is not a Bob deployment.

Never overwrite production during a restore check.

Apply committed migrations in order. Import the primary table data.

Recreate FTS5 tables and triggers. Rebuild every search projection.

Recover wrapped data keys through OpenBao. Verify one record from each key version.

Compare row counts and content hashes. Run deterministic safety tests.

Record the observed recovery point and recovery time.
