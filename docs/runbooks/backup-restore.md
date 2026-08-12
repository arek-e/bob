# Backup and restore runbook

## Current state

Bob has a tested backup tool and Kubernetes schedule.

The repository does not contain proof of a completed production backup or restore drill.

Use the production evidence checklist before you claim recovery readiness.

## Objectives

- Target a four-hour recovery point objective.
- Target a one-day recovery time objective initially.
- Keep 42 encrypted copies. This equals seven days at six successful backups each day.
- Keep a second copy on node-independent storage outside Cloudflare.

D1 Time Travel is useful recovery support. It is not an independent backup.

## Current storage limitation

The CronJob writes to the `bob-backups` PersistentVolumeClaim.

The claim uses the `local-path` storage class. It stores data on one Kubernetes node.

This storage is outside Cloudflare. It is not independent from the Kubernetes node.

A node or disk failure can remove every retained copy.

The `Prune=false` annotation prevents normal Argo CD pruning. It does not prevent disk loss.

Copy each encrypted archive to node-independent storage. Do not close the backup gate before this exists.

## Backup data contract

The exporter reads primary D1 tables and every object in the private R2 bucket.

It excludes these derived D1 records:

- D1 migration metadata.
- `search_documents`.
- Every `search_documents_fts` table.
- Other Cloudflare internal tables.

The exporter gets the primary table names first. It then sends every table query in one D1 batch.

D1 runs that batch sequentially in one transaction. The row data has one transactional snapshot.

R2 export is separate from the D1 transaction. The manifest records the start and finish cutoff times.

An R2 object can change during that window. Never describe the two stores as one atomic snapshot.

The archive records these integrity values:

- One SHA-256 hash for each ordered D1 table row set.
- One SHA-256 hash for each R2 object.
- The R2 object key, content type, and available ETag.
- One SHA-256 hash for the canonical archive manifest.

The tool compresses the archive with gzip. It then encrypts the complete archive to an age X25519 recipient.

The output name is `bob-<cutoff>.json.gz.age`. The file mode is `0600`.

The current compressed archive budget is 256 MiB. The job fails closed when the archive exceeds it.

## Schedule and retention

The `bob-data-backup` CronJob runs at minute 15 every four hours.

It forbids concurrent jobs. It has a one-hour deadline and two retries.

After a successful write, the tool sorts matching archive names. It keeps the newest 42 files.

The retention code rejects zero or negative retention values.

## Credential isolation

External Secrets reads the scheduled runtime record from this OpenBao path:

```text
ops/apps/prod/bob/backup/runtime
```

The `bob-backup-secret-delivery` policy can read only that record.

The scheduled job receives these secret classes:

- A read-only Cloudflare D1 token.
- A read-only R2 S3 access key.
- The public age recipient.

The scheduled job must never receive these recovery secrets:

- The age identity.
- A D1 write token.
- An R2 write or delete key.

Store the age identity and temporary restore credentials under a separate recovery path.

Use this path for the recovery record:

```text
ops/apps/prod/bob/backup/recovery
```

Do not add that path to the scheduled ExternalSecret or its OpenBao policy.

Mount the age identity as a file for an explicit verify or restore command. Do not use an environment value.

Use short-lived restore credentials. Revoke them after each drill.

## Release validation

Run these checks from the repository root:

```sh
pnpm --filter @bob/data-backup typecheck
pnpm exec vitest run tools/data-backup/test
pnpm --filter @bob/data-backup build
pnpm exec vitest run infra/cloudflare/test/deployment-readiness.test.ts
kubectl kustomize infra/kubernetes >/dev/null
```

The production overlay must pin the backup image by digest.

The rendered output must have no invalid image sentinel or unresolved OpenBao address.

## First production backup

Confirm the secret and claim before you start a job:

```sh
kubectl --context=teampitch-prod -n bob wait \
  --for=condition=Ready externalsecret/bob-backup-runtime \
  --timeout=2m
kubectl --context=teampitch-prod -n bob get pvc bob-backups
kubectl --context=teampitch-prod -n bob get cronjob bob-data-backup
```

Create one job from the reviewed CronJob:

```sh
job_name="bob-data-backup-manual-$(date -u +%Y%m%d%H%M%S)"
kubectl --context=teampitch-prod -n bob create job \
  --from=cronjob/bob-data-backup "$job_name"
kubectl --context=teampitch-prod -n bob wait \
  --for=condition=Complete "job/$job_name" \
  --timeout=70m
kubectl --context=teampitch-prod -n bob logs "job/$job_name"
```

The completion log contains counts and cutoff times only. It must not contain record text or credentials.

Confirm one new `.json.gz.age` file exists. Confirm older matching files remain within the 42-copy limit.

Copy the encrypted file to node-independent storage. Verify the copied ciphertext hash.

## Archive verification

Run verification away from the scheduled job. Use a read-only copy of the archive.

Set `BACKUP_INPUT_FILE` and `BACKUP_AGE_IDENTITY_FILE` to mounted file paths.

Then run:

```sh
pnpm --filter @bob/data-backup verify
```

The command decrypts the archive. It verifies every table, object, and manifest hash.

The command prints counts and times only. It does not print private rows or objects.

## Isolated restore drill

Never restore a drill into production resources.

Provide the selected archive, mounted age identity, and short-lived recovery credentials through Varlock.

Run this explicit command:

```sh
pnpm --filter @bob/data-backup exec varlock run \
  --inject blob \
  --skip-cache \
  -- tsx src/index.ts restore-drill
```

The drill performs these actions:

1. It decrypts and verifies the archive.
2. It creates a disposable D1 database in the EU jurisdiction.
3. It applies committed migrations in order.
4. It imports primary table rows in dependency order.
5. It verifies each restored table row count.
6. It creates a disposable EU R2 bucket when the archive has objects.
7. It writes and reads each R2 object.
8. It compares each restored object SHA-256 hash.
9. It deletes every disposable object, bucket, and database in `finally` cleanup.
10. It reports observed recovery point and recovery time seconds.

The drill rejects a database or bucket outside the EU jurisdiction.

If cleanup fails, record the exact resource names. Remove only those verified disposable resources.

## Primary-table restore and FTS rebuild

The restore imports primary tables only. It does not import `search_documents` or FTS projections.

Committed migrations recreate the empty search tables and FTS structure.

After restore, rebuild each search projection from its authoritative primary record.

Apply current model and channel eligibility rules during the rebuild.

Then verify these cases with the restored application path:

- One confirmed fact appears with its source label.
- One superseded fact does not appear.
- One deleted journal summary does not appear.
- One active reminder appears only for its owner.
- One routine and active workout appear only for their owner.

Bob does not yet have an automated projection rebuild command.

The current drill proves primary rows, row counts, and R2 hashes. It does not prove search recovery.

Do not close the full restore gate until the rebuild command exists and passes in a drill.

## Application key verification

The archive includes encrypted application data and wrapped owner data keys.

Archive decryption does not prove that application ciphertext is usable.

For a full drill, load the required wrapping-key versions through the approved OpenBao recovery flow.

Decrypt one owner record from each stored key version. Do not print the plaintext.

Record only the key version, result, and opaque record ID.

## Drill record

Record this evidence after each production drill:

- Archive name and ciphertext SHA-256 hash.
- D1 and R2 cutoff start and finish times.
- Table, row, and object counts.
- Recovery point seconds.
- Recovery time seconds.
- Restored EU resource names and deletion results.
- FTS rebuild result and search checks.
- Application key-version checks.
- Node-independent copy location and ciphertext hash result.

Never record credentials, private text, object bytes, or decrypted data.

### 2026-08-11 primary-data drill

- Ciphertext SHA-256: `a3c4156f87ef467b8788a97b796d40e990046687bd1ee189bb99a5cce5a7a93a`.
- Restored 37 primary tables and 56 rows.
- The source archive contained no R2 objects.
- Recovery point age was 1,555.256 seconds.
- Recovery time was 24.099 seconds.
- The D1 database used EU jurisdiction.
- The drill deleted the disposable database.
- The drill did not create an R2 bucket because the archive had no objects.
- The drill recreated the migration ledger.
- FTS rebuild and application-key checks remain open.
- The encrypted probe is not the required durable second copy.

## Production acceptance

- [x] The ExternalSecret is ready with the scoped runtime policy.
- [x] The backup claim is bound.
- [x] One manual encrypted backup completed.
- [ ] One scheduled encrypted backup completed.
- [ ] The 42-copy retention rule ran without deleting unrelated files.
- [ ] One ciphertext copy exists on node-independent storage outside Cloudflare.
- [ ] Archive verification passed with the isolated age identity.
- [ ] An EU D1 and R2 restore drill completed and cleaned up.
- [ ] The search projections were rebuilt and queried through Bob.
- [ ] Application decryption passed for every stored key version.
- [ ] The measured recovery point is at most four hours.
- [ ] The measured recovery time is at most one day.
