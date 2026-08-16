import { describe, expect, it } from "vitest"

import { decodeBackupCommandConfiguration, parseBackupCommand } from "../src/config.ts"

const backupEnvironment = {
  CLOUDFLARE_ACCOUNT_ID: "account",
  CLOUDFLARE_D1_DATABASE_ID: "database",
  CLOUDFLARE_API_TOKEN: "source-token",
  R2_BUCKET: "source-bucket",
  R2_ENDPOINT: "https://r2.example.com",
  R2_ACCESS_KEY_ID: "source-key",
  R2_SECRET_ACCESS_KEY: "source-secret",
  BACKUP_AGE_RECIPIENT: "age1recipient",
  BACKUP_OUTPUT_DIRECTORY: "/backups",
  BACKUP_MAX_BYTES: 1024,
  BACKUP_RETENTION_COUNT: 42,
  BACKUP_COPY_PREFIX: "bob"
} as const

const verifyEnvironment = {
  BACKUP_INPUT_FILE: "/backup.age",
  BACKUP_AGE_IDENTITY_FILE: "/identity.txt"
} as const

const restoreEnvironment = {
  ...verifyEnvironment,
  CLOUDFLARE_ACCOUNT_ID: "account",
  CLOUDFLARE_RESTORE_API_TOKEN: "restore-token",
  BACKUP_MIGRATIONS_DIRECTORY: "/migrations",
  BACKUP_RESTORE_DATABASE_PREFIX: "database-prefix",
  BACKUP_RESTORE_BUCKET_PREFIX: "bucket-prefix",
  R2_ENDPOINT: "https://r2.example.com",
  R2_RESTORE_ACCESS_KEY_ID: "restore-key",
  R2_RESTORE_SECRET_ACCESS_KEY: "restore-secret"
} as const

const independentCopyFields = [
  "BACKUP_COPY_ENDPOINT",
  "BACKUP_COPY_REGION",
  "BACKUP_COPY_BUCKET",
  "BACKUP_COPY_ACCESS_KEY_ID",
  "BACKUP_COPY_SECRET_ACCESS_KEY"
] as const

const partialIndependentCopies = Array.from(
  { length: 2 ** independentCopyFields.length - 2 },
  (_, mask) =>
    Object.fromEntries(
      independentCopyFields
        .filter((_, index) => ((mask + 1) & (1 << index)) !== 0)
        .map((name) => [name, "configured"])
    )
)

describe("backup command configuration", () => {
  it.each(["backup", "verify", "restore-drill"] as const)("parses %s", (command) => {
    expect(parseBackupCommand(command)).toBe(command)
  })

  it("rejects an unknown command before configuration decoding", () => {
    expect(() => parseBackupCommand("delete")).toThrow("Use backup, verify, or restore-drill")
  })

  it("decodes backup with the independent copy disabled", () => {
    expect(decodeBackupCommandConfiguration("backup", backupEnvironment)).toMatchObject({
      command: "backup",
      independentCopy: { state: "disabled" }
    })
  })

  it("decodes backup with a complete independent copy", () => {
    const configuration = decodeBackupCommandConfiguration("backup", {
      ...backupEnvironment,
      BACKUP_COPY_ENDPOINT: "https://copy.example.com",
      BACKUP_COPY_REGION: "auto",
      BACKUP_COPY_BUCKET: "copy-bucket",
      BACKUP_COPY_ACCESS_KEY_ID: "copy-key",
      BACKUP_COPY_SECRET_ACCESS_KEY: "copy-secret"
    })
    expect(configuration).toMatchObject({
      command: "backup",
      independentCopy: {
        state: "configured",
        endpoint: "https://copy.example.com",
        prefix: "bob"
      }
    })
  })

  it.each(partialIndependentCopies)("rejects partial independent copy %#", (partialCopy) => {
    expect(() =>
      decodeBackupCommandConfiguration("backup", {
        ...backupEnvironment,
        ...partialCopy
      })
    ).toThrow("Set all independent backup copy fields together")
  })

  it("decodes verify without backup or recovery settings", () => {
    expect(decodeBackupCommandConfiguration("verify", verifyEnvironment)).toEqual({
      command: "verify",
      inputFile: "/backup.age",
      identityFile: "/identity.txt"
    })
  })

  it("decodes restore without backup source settings", () => {
    expect(decodeBackupCommandConfiguration("restore-drill", restoreEnvironment)).toMatchObject({
      command: "restore-drill",
      recovery: {
        accountId: "account",
        apiToken: "restore-token",
        r2AccessKeyId: "restore-key"
      }
    })
  })

  it.each([
    ["backup", "CLOUDFLARE_API_TOKEN"],
    ["verify", "BACKUP_INPUT_FILE"],
    ["restore-drill", "CLOUDFLARE_RESTORE_API_TOKEN"]
  ] as const)("requires %s command field %s", (command, name) => {
    const environment = {
      ...(command === "backup"
        ? backupEnvironment
        : command === "verify"
          ? verifyEnvironment
          : restoreEnvironment),
      [name]: undefined
    }
    expect(() => decodeBackupCommandConfiguration(command, environment)).toThrow(
      `Set ${name} for the ${command} command`
    )
  })
})
