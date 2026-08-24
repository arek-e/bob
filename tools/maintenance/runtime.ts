import type { ConversationStoreAdapter } from "@bob/conversations-types/store"
import type { PostgresqlDatabaseService } from "@bob/db-service/postgresql"
import type { CoreDatabase } from "@bob/db-types"
import type { ProductionDataInspectorAdapter } from "@bob/operations-types/production-data"

import { createConversationStore } from "@bob/conversations-service/store"
import { PostgresqlDatabase, postgresqlDatabaseLayer } from "@bob/db-service/postgresql"
import { createProductionDataInspector } from "@bob/operations-service/production-data/inspector"
import { createDataProtection } from "@bob/policy-service/data-protection"
import { createOwnerDataKeyStore } from "@bob/policy-service/owner-data-key"
import { ManagedRuntime, Schema } from "effect"
import { resolve } from "node:path"

import type { MaintenanceExecutionContext } from "./context.js"

import { MaintenanceCliError } from "./cli.js"

export interface MaintenanceRuntime {
  readonly executionContext: MaintenanceExecutionContext
  readonly productionData: ProductionDataInspectorAdapter
  readonly getConversations: () => Promise<MaintenanceConversationReader>
  readonly migrate: () => Promise<void>
  readonly dispose: () => Promise<void>
}

export type MaintenanceConversationReader = Pick<ConversationStoreAdapter, "listMessages">

export interface MaintenanceRuntimeOptions {
  readonly executionContext: MaintenanceExecutionContext
  readonly env?: NodeJS.ProcessEnv
  readonly workingDirectory?: string
}

export async function createMaintenanceRuntime({
  executionContext,
  env = process.env,
  workingDirectory = process.cwd()
}: MaintenanceRuntimeOptions): Promise<MaintenanceRuntime> {
  const databaseUrl = requiredEnvironment(env, "DATABASE_URL")
  const migrationsFolder =
    env.BOB_MIGRATIONS_FOLDER ?? resolve(workingDirectory, "packages/db/service/migrations")
  const databaseRuntime = ManagedRuntime.make(
    postgresqlDatabaseLayer(databaseUrl, {
      migrationsFolder,
      maximumConnections: 2
    })
  )

  let database: PostgresqlDatabaseService
  try {
    database = await databaseRuntime.runPromise(PostgresqlDatabase)
  } catch {
    await databaseRuntime.dispose()
    throw new MaintenanceCliError("Maintenance database connection failed")
  }

  const productionData = createProductionDataInspector(database.applicationStorage)
  let conversations: Promise<ConversationStoreAdapter> | undefined

  return {
    executionContext,
    productionData,
    getConversations() {
      conversations ??= createConversationStoreForMaintenance(database.applicationStorage, env)
      return conversations
    },
    async migrate() {
      try {
        await databaseRuntime.runPromise(database.migrate)
      } catch {
        throw new MaintenanceCliError("Database migration failed")
      }
    },
    async dispose() {
      await databaseRuntime.dispose()
    }
  }
}

function createConversationStoreForMaintenance(
  database: CoreDatabase,
  env: NodeJS.ProcessEnv
): Promise<ConversationStoreAdapter> {
  return Promise.resolve().then(() => {
    const activeVersionValue = requiredEnvironment(env, "DATA_KEK_ACTIVE_VERSION")
    const activeVersion = Number.parseInt(activeVersionValue, 10)
    if (!Number.isInteger(activeVersion) || activeVersion < 1) {
      throw new MaintenanceCliError("DATA_KEK_ACTIVE_VERSION is invalid")
    }

    const keyring = readKeyring(requiredEnvironment(env, "DATA_KEK_KEYRING_JSON"))
    if (keyring[activeVersion] === undefined) {
      throw new MaintenanceCliError("DATA_KEK_KEYRING_JSON does not contain the active version")
    }

    const protection = createDataProtection(
      keyring,
      activeVersion,
      requiredEnvironment(env, "DATA_LOOKUP_KEY")
    )
    const ownerDataKeys = createOwnerDataKeyStore(database, protection, {
      defaultTimeZone: env.OWNER_TIME_ZONE ?? "UTC"
    })
    return createConversationStore(database, protection, {
      ownerDataKeys,
      ownerTimeZone: env.OWNER_TIME_ZONE ?? "UTC",
      channelProviderId: env.BOB_CHANNEL_PROVIDER_ID ?? "sendblue"
    })
  })
}

function readKeyring(value: string) {
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
    const keyring = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.String))(parsed)
    const entries = Object.entries(keyring).map(([version, key]) => {
      const parsedVersion = Number.parseInt(version, 10)
      if (!/^\d+$/u.test(version) || !Number.isInteger(parsedVersion) || parsedVersion < 1) {
        throw new Error("invalid keyring version")
      }
      return [parsedVersion, key] as const
    })
    return Object.fromEntries(entries)
  } catch {
    throw new MaintenanceCliError("DATA_KEK_KEYRING_JSON is invalid")
  }
}

function requiredEnvironment(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]
  if (value === undefined || value.length === 0) {
    throw new MaintenanceCliError(`${name} is required`)
  }
  return value
}
