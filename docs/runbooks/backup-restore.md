# Backup and restore

Status: active
Schedule authority: Coolify

## Backup contract

The `backup-runner` task runs at `15 */4 * * *`.

This schedule gives Bob a four-hour target RPO.

The maximum accepted backup age is 18,000 seconds.

The exact command and limits are in `infra/coolify/runtime-contract.json`.

Each run exports D1 and R2 data to the persistent local volume.

Each run encrypts the archive with age.

Each run copies the encrypted archive to the independent R2 bucket.

Require the result field `independentCopy` to equal `completed`.

Enable Coolify failure notifications for the task.

The observer reports content-free file age for Bob and Nango backups.

## Manual backup

Run the configured task on `backup-runner`.

Do not change the command in the Coolify console.

Do not print environment values or archive contents.

Record the archive timestamp, size, source SHA, and copy status.

## Restore drill

Use a temporary D1 database and a temporary R2 bucket.

Do not restore into production during a drill.

Download the newest independent encrypted copy.

Decrypt it only on the trusted recovery host.

Run the restore command from `@bob/data-backup` with the temporary targets.

Apply committed D1 migrations before acceptance checks.

Compare record counts and R2 object counts.

Verify one encrypted message through the application boundary.

Delete temporary recovery resources after the drill.

Record the achieved RPO and recovery time.

## Production restore

Stop inbound processing and the backup task.

Create new recovery targets.

Restore the newest independent archive.

Point the reviewed Cloudflare plan at the restored targets.

Run Core, agent, delivery, and reminder acceptance checks.

Resume the Tunnel only after readiness passes.

Run a new backup after recovery.

## Limits

The local copy shares the private runtime host.

The independent copy shares the Cloudflare account with source data.

The current design does not recover a Cloudflare account loss.
