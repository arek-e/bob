import type { CoercedEnvSchema } from "./environment.generated.ts"

export type BackupCommand = "backup" | "verify" | "restore-drill"

interface IndependentCopyConfiguration {
  readonly state: "configured"
  readonly endpoint: string
  readonly region: string
  readonly bucket: string
  readonly prefix: string
  readonly accessKeyId: string
  readonly secretAccessKey: string
}

interface DisabledIndependentCopy {
  readonly state: "disabled"
}

export interface BackupConfiguration {
  readonly command: "backup"
  readonly source: {
    readonly accountId: string
    readonly databaseId: string
    readonly apiToken: string
    readonly r2Bucket: string
    readonly r2Endpoint: string
    readonly r2AccessKeyId: string
    readonly r2SecretAccessKey: string
  }
  readonly recipient: string
  readonly outputDirectory: string
  readonly maxBytes: number
  readonly retentionCount: number
  readonly independentCopy: IndependentCopyConfiguration | DisabledIndependentCopy
}

export interface VerifyConfiguration {
  readonly command: "verify"
  readonly inputFile: string
  readonly identityFile: string
}

export interface RestoreDrillConfiguration {
  readonly command: "restore-drill"
  readonly inputFile: string
  readonly identityFile: string
  readonly recovery: {
    readonly accountId: string
    readonly apiToken: string
    readonly migrationsDirectory: string
    readonly databasePrefix: string
    readonly r2BucketPrefix: string
    readonly r2Endpoint: string
    readonly r2AccessKeyId: string
    readonly r2SecretAccessKey: string
  }
}

export type BackupCommandConfiguration =
  | BackupConfiguration
  | VerifyConfiguration
  | RestoreDrillConfiguration

type BackupEnvironment = Partial<CoercedEnvSchema>

function requiredString(
  value: string | undefined,
  name: keyof CoercedEnvSchema,
  command: BackupCommand
): string {
  if (value === undefined || value.length === 0) {
    throw new Error(`Set ${name} for the ${command} command`)
  }
  return value
}

function requiredNumber(
  value: number | undefined,
  name: keyof CoercedEnvSchema,
  command: BackupCommand
): number {
  if (value === undefined || !Number.isFinite(value)) {
    throw new Error(`Set ${name} for the ${command} command`)
  }
  return value
}

function decodeIndependentCopy(
  environment: BackupEnvironment
): IndependentCopyConfiguration | DisabledIndependentCopy {
  const fields = {
    endpoint: environment.BACKUP_COPY_ENDPOINT,
    region: environment.BACKUP_COPY_REGION,
    bucket: environment.BACKUP_COPY_BUCKET,
    accessKeyId: environment.BACKUP_COPY_ACCESS_KEY_ID,
    secretAccessKey: environment.BACKUP_COPY_SECRET_ACCESS_KEY
  }
  const configuredFields = Object.values(fields).filter((value) => value !== undefined)
  if (configuredFields.length === 0) return { state: "disabled" }
  if (configuredFields.length !== Object.keys(fields).length) {
    throw new Error("Set all independent backup copy fields together")
  }
  return {
    state: "configured",
    endpoint: requiredString(environment.BACKUP_COPY_ENDPOINT, "BACKUP_COPY_ENDPOINT", "backup"),
    region: requiredString(environment.BACKUP_COPY_REGION, "BACKUP_COPY_REGION", "backup"),
    bucket: requiredString(environment.BACKUP_COPY_BUCKET, "BACKUP_COPY_BUCKET", "backup"),
    prefix: requiredString(environment.BACKUP_COPY_PREFIX, "BACKUP_COPY_PREFIX", "backup"),
    accessKeyId: requiredString(
      environment.BACKUP_COPY_ACCESS_KEY_ID,
      "BACKUP_COPY_ACCESS_KEY_ID",
      "backup"
    ),
    secretAccessKey: requiredString(
      environment.BACKUP_COPY_SECRET_ACCESS_KEY,
      "BACKUP_COPY_SECRET_ACCESS_KEY",
      "backup"
    )
  }
}

export function parseBackupCommand(value: string | undefined): BackupCommand {
  if (value === "backup" || value === "verify" || value === "restore-drill") return value
  throw new Error("Use backup, verify, or restore-drill")
}

export function decodeBackupCommandConfiguration(
  command: BackupCommand,
  environment: BackupEnvironment
): BackupCommandConfiguration {
  if (command === "verify") {
    return {
      command,
      inputFile: requiredString(environment.BACKUP_INPUT_FILE, "BACKUP_INPUT_FILE", command),
      identityFile: requiredString(
        environment.BACKUP_AGE_IDENTITY_FILE,
        "BACKUP_AGE_IDENTITY_FILE",
        command
      )
    }
  }
  if (command === "restore-drill") {
    return {
      command,
      inputFile: requiredString(environment.BACKUP_INPUT_FILE, "BACKUP_INPUT_FILE", command),
      identityFile: requiredString(
        environment.BACKUP_AGE_IDENTITY_FILE,
        "BACKUP_AGE_IDENTITY_FILE",
        command
      ),
      recovery: {
        accountId: requiredString(
          environment.CLOUDFLARE_ACCOUNT_ID,
          "CLOUDFLARE_ACCOUNT_ID",
          command
        ),
        apiToken: requiredString(
          environment.CLOUDFLARE_RESTORE_API_TOKEN,
          "CLOUDFLARE_RESTORE_API_TOKEN",
          command
        ),
        migrationsDirectory: requiredString(
          environment.BACKUP_MIGRATIONS_DIRECTORY,
          "BACKUP_MIGRATIONS_DIRECTORY",
          command
        ),
        databasePrefix: requiredString(
          environment.BACKUP_RESTORE_DATABASE_PREFIX,
          "BACKUP_RESTORE_DATABASE_PREFIX",
          command
        ),
        r2BucketPrefix: requiredString(
          environment.BACKUP_RESTORE_BUCKET_PREFIX,
          "BACKUP_RESTORE_BUCKET_PREFIX",
          command
        ),
        r2Endpoint: requiredString(environment.R2_ENDPOINT, "R2_ENDPOINT", command),
        r2AccessKeyId: requiredString(
          environment.R2_RESTORE_ACCESS_KEY_ID,
          "R2_RESTORE_ACCESS_KEY_ID",
          command
        ),
        r2SecretAccessKey: requiredString(
          environment.R2_RESTORE_SECRET_ACCESS_KEY,
          "R2_RESTORE_SECRET_ACCESS_KEY",
          command
        )
      }
    }
  }
  return {
    command,
    source: {
      accountId: requiredString(
        environment.CLOUDFLARE_ACCOUNT_ID,
        "CLOUDFLARE_ACCOUNT_ID",
        command
      ),
      databaseId: requiredString(
        environment.CLOUDFLARE_D1_DATABASE_ID,
        "CLOUDFLARE_D1_DATABASE_ID",
        command
      ),
      apiToken: requiredString(environment.CLOUDFLARE_API_TOKEN, "CLOUDFLARE_API_TOKEN", command),
      r2Bucket: requiredString(environment.R2_BUCKET, "R2_BUCKET", command),
      r2Endpoint: requiredString(environment.R2_ENDPOINT, "R2_ENDPOINT", command),
      r2AccessKeyId: requiredString(environment.R2_ACCESS_KEY_ID, "R2_ACCESS_KEY_ID", command),
      r2SecretAccessKey: requiredString(
        environment.R2_SECRET_ACCESS_KEY,
        "R2_SECRET_ACCESS_KEY",
        command
      )
    },
    recipient: requiredString(environment.BACKUP_AGE_RECIPIENT, "BACKUP_AGE_RECIPIENT", command),
    outputDirectory: requiredString(
      environment.BACKUP_OUTPUT_DIRECTORY,
      "BACKUP_OUTPUT_DIRECTORY",
      command
    ),
    maxBytes: requiredNumber(environment.BACKUP_MAX_BYTES, "BACKUP_MAX_BYTES", command),
    retentionCount: requiredNumber(
      environment.BACKUP_RETENTION_COUNT,
      "BACKUP_RETENTION_COUNT",
      command
    ),
    independentCopy: decodeIndependentCopy(environment)
  }
}
