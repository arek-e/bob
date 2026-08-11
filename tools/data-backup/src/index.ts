import { readFile, readdir, unlink } from "node:fs/promises"
import { join } from "node:path"

import { decryptArchive, encryptArchive } from "./archive.ts"
import { makeCloudflareBackupSource } from "./cloudflare.ts"
import { ENV } from "./environment.generated.ts"
import { writeEncryptedBackup } from "./persistence.ts"
import { makeRestoreDrill } from "./restore.ts"
import { expiredBackupNames } from "./retention.ts"

async function backup(): Promise<void> {
  const source = makeCloudflareBackupSource({
    accountId: ENV.CLOUDFLARE_ACCOUNT_ID,
    databaseId: ENV.CLOUDFLARE_D1_DATABASE_ID,
    apiToken: ENV.CLOUDFLARE_API_TOKEN,
    r2Bucket: ENV.R2_BUCKET,
    r2Endpoint: ENV.R2_ENDPOINT,
    r2AccessKeyId: ENV.R2_ACCESS_KEY_ID,
    r2SecretAccessKey: ENV.R2_SECRET_ACCESS_KEY
  })
  const archive = await source.export()
  const ciphertext = await encryptArchive(archive, ENV.BACKUP_AGE_RECIPIENT, ENV.BACKUP_MAX_BYTES)
  const filename = `bob-${archive.createdAt.replaceAll(":", "-")}.json.gz.age`
  await writeEncryptedBackup({
    outputDirectory: ENV.BACKUP_OUTPUT_DIRECTORY,
    filename,
    ciphertext
  })
  const backups = await readdir(ENV.BACKUP_OUTPUT_DIRECTORY)
  for (const expired of expiredBackupNames(backups, ENV.BACKUP_RETENTION_COUNT)) {
    await unlink(join(ENV.BACKUP_OUTPUT_DIRECTORY, expired))
  }
  console.log(
    JSON.stringify({
      status: "completed",
      filename,
      tableCount: archive.tables.length,
      objectCount: archive.objects.length,
      startedAt: archive.cutoffStartedAt,
      finishedAt: archive.cutoffFinishedAt
    })
  )
}

async function verify(): Promise<void> {
  if (ENV.BACKUP_INPUT_FILE === undefined || ENV.BACKUP_AGE_IDENTITY_FILE === undefined) {
    throw new Error("Backup input and identity files are required for verification")
  }
  const [ciphertext, identity] = await Promise.all([
    readFile(ENV.BACKUP_INPUT_FILE),
    readFile(ENV.BACKUP_AGE_IDENTITY_FILE, "utf8")
  ])
  const archive = await decryptArchive(ciphertext, identity)
  console.log(
    JSON.stringify({
      status: "verified",
      createdAt: archive.createdAt,
      tableCount: archive.tables.length,
      rowCount: archive.tables.reduce((sum, table) => sum + table.rows.length, 0),
      objectCount: archive.objects.length
    })
  )
}

async function restoreDrill(): Promise<void> {
  if (
    ENV.BACKUP_INPUT_FILE === undefined ||
    ENV.BACKUP_AGE_IDENTITY_FILE === undefined ||
    ENV.CLOUDFLARE_RESTORE_API_TOKEN === undefined ||
    ENV.R2_RESTORE_ACCESS_KEY_ID === undefined ||
    ENV.R2_RESTORE_SECRET_ACCESS_KEY === undefined
  ) {
    throw new Error(
      "Backup input, identity, and recovery credentials are required for a restore drill"
    )
  }
  const [ciphertext, identity] = await Promise.all([
    readFile(ENV.BACKUP_INPUT_FILE),
    readFile(ENV.BACKUP_AGE_IDENTITY_FILE, "utf8")
  ])
  const archive = await decryptArchive(ciphertext, identity)
  const drill = makeRestoreDrill({
    accountId: ENV.CLOUDFLARE_ACCOUNT_ID,
    apiToken: ENV.CLOUDFLARE_RESTORE_API_TOKEN,
    migrationsDirectory: ENV.BACKUP_MIGRATIONS_DIRECTORY,
    databasePrefix: ENV.BACKUP_RESTORE_DATABASE_PREFIX,
    r2BucketPrefix: ENV.BACKUP_RESTORE_BUCKET_PREFIX,
    r2Endpoint: ENV.R2_ENDPOINT,
    r2AccessKeyId: ENV.R2_RESTORE_ACCESS_KEY_ID,
    r2SecretAccessKey: ENV.R2_RESTORE_SECRET_ACCESS_KEY
  })
  console.log(JSON.stringify(await drill.run(archive)))
}

const command = process.argv[2]
if (command === "backup") await backup()
else if (command === "verify") await verify()
else if (command === "restore-drill") await restoreDrill()
else throw new Error("Use backup, verify, or restore-drill")
