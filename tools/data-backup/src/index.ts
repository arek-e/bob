import { readFile, readdir, unlink } from "node:fs/promises"
import { join } from "node:path"

import { decryptArchive, encryptArchive } from "./archive.ts"
import { makeCloudflareBackupSource } from "./cloudflare.ts"
import {
  decodeBackupCommandConfiguration,
  parseBackupCommand,
  type BackupConfiguration,
  type RestoreDrillConfiguration,
  type VerifyConfiguration
} from "./config.ts"
import { ENV } from "./environment.generated.ts"
import { uploadEncryptedBackup, writeEncryptedBackup } from "./persistence.ts"
import { makeRestoreDrill } from "./restore.ts"
import { expiredBackupNames } from "./retention.ts"

async function backup(configuration: BackupConfiguration): Promise<void> {
  const source = makeCloudflareBackupSource({
    accountId: configuration.source.accountId,
    databaseId: configuration.source.databaseId,
    apiToken: configuration.source.apiToken,
    r2Bucket: configuration.source.r2Bucket,
    r2Endpoint: configuration.source.r2Endpoint,
    r2AccessKeyId: configuration.source.r2AccessKeyId,
    r2SecretAccessKey: configuration.source.r2SecretAccessKey
  })
  const archive = await source.export()
  const ciphertext = await encryptArchive(archive, configuration.recipient, configuration.maxBytes)
  const filename = `bob-${archive.createdAt.replaceAll(":", "-")}.json.gz.age`
  await writeEncryptedBackup({
    outputDirectory: configuration.outputDirectory,
    filename,
    ciphertext
  })
  if (configuration.independentCopy.state === "configured") {
    await uploadEncryptedBackup({
      endpoint: configuration.independentCopy.endpoint,
      region: configuration.independentCopy.region,
      bucket: configuration.independentCopy.bucket,
      prefix: configuration.independentCopy.prefix,
      filename,
      ciphertext,
      accessKeyId: configuration.independentCopy.accessKeyId,
      secretAccessKey: configuration.independentCopy.secretAccessKey
    })
  }
  const backups = await readdir(configuration.outputDirectory)
  for (const expired of expiredBackupNames(backups, configuration.retentionCount)) {
    await unlink(join(configuration.outputDirectory, expired))
  }
  console.log(
    JSON.stringify({
      status: "completed",
      filename,
      tableCount: archive.tables.length,
      objectCount: archive.objects.length,
      independentCopy:
        configuration.independentCopy.state === "configured" ? "completed" : "disabled",
      startedAt: archive.cutoffStartedAt,
      finishedAt: archive.cutoffFinishedAt
    })
  )
}

async function verify(configuration: VerifyConfiguration): Promise<void> {
  const [ciphertext, identity] = await Promise.all([
    readFile(configuration.inputFile),
    readFile(configuration.identityFile, "utf8")
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

async function restoreDrill(configuration: RestoreDrillConfiguration): Promise<void> {
  const [ciphertext, identity] = await Promise.all([
    readFile(configuration.inputFile),
    readFile(configuration.identityFile, "utf8")
  ])
  const archive = await decryptArchive(ciphertext, identity)
  const drill = makeRestoreDrill({
    accountId: configuration.recovery.accountId,
    apiToken: configuration.recovery.apiToken,
    migrationsDirectory: configuration.recovery.migrationsDirectory,
    databasePrefix: configuration.recovery.databasePrefix,
    r2BucketPrefix: configuration.recovery.r2BucketPrefix,
    r2Endpoint: configuration.recovery.r2Endpoint,
    r2AccessKeyId: configuration.recovery.r2AccessKeyId,
    r2SecretAccessKey: configuration.recovery.r2SecretAccessKey
  })
  console.log(JSON.stringify(await drill.run(archive)))
}

const command = parseBackupCommand(process.argv[2])
const configuration = decodeBackupCommandConfiguration(command, ENV)
if (configuration.command === "backup") await backup(configuration)
else if (configuration.command === "verify") await verify(configuration)
else await restoreDrill(configuration)
