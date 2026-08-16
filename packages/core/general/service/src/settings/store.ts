import type { CoreDatabase } from "@bob/core-types/database"
import type {
  HourCycle,
  OwnerSettings,
  OwnerSettingsUpdate,
  SettingsConnection
} from "@bob/core-types/settings"

import { channels, users } from "@bob/db-service/schema/conversations"
import { and, eq } from "drizzle-orm"
import { Context, Layer } from "effect"

import type { DataProtection } from "../policy/data-protection.ts"
import type { OwnerDataKeyStore } from "../policy/owner-data-key.ts"

import {
  completeEffect,
  completedEffect,
  completedEffectAfterConflict,
  type EffectIdentity
} from "../policy/effect-outcome.ts"
import { makeOwnerDataKeyStore } from "../policy/owner-data-key.ts"

export interface OwnerSettingsStore {
  get(ownerId: string): Promise<OwnerSettings>
  update(
    ownerId: string,
    input: OwnerSettingsUpdate,
    idempotencyKey: string
  ): Promise<OwnerSettings>
  connections(ownerId: string): Promise<readonly SettingsConnection[]>
}

export const OwnerSettingsStore = Context.Service<OwnerSettingsStore>("bob/OwnerSettingsStore")

export interface OwnerSettingsStoreOptions {
  readonly defaultTimeZone: string
  readonly channelProviderId: string
  readonly defaultLocale?: string
  readonly defaultHourCycle?: HourCycle
  readonly ownerDataKeys?: OwnerDataKeyStore
  readonly now?: () => Date
  readonly randomUuid?: () => string
}

interface OwnerSettingsValues {
  updatedAt: string
  timeZone?: string
  locale?: string
  hourCycle?: HourCycle
}

function canonicalTimeZone(value: string): string {
  try {
    return new Intl.DateTimeFormat("en", { timeZone: value }).resolvedOptions().timeZone
  } catch {
    throw new Error("Invalid time zone")
  }
}

function canonicalLocale(value: string): string {
  try {
    const [locale] = Intl.getCanonicalLocales(value)
    if (locale === undefined) throw new Error("Invalid locale")
    return locale
  } catch {
    throw new Error("Invalid locale")
  }
}

export function makeOwnerSettingsStore(
  database: CoreDatabase,
  protection: DataProtection,
  options: OwnerSettingsStoreOptions
): OwnerSettingsStore {
  const now = options.now ?? (() => new Date())
  const randomUuid = options.randomUuid ?? (() => crypto.randomUUID())
  const defaultTimeZone = canonicalTimeZone(options.defaultTimeZone)
  const defaultLocale = canonicalLocale(options.defaultLocale ?? "en")
  const defaultHourCycle = options.defaultHourCycle ?? "auto"
  const ownerDataKeys =
    options.ownerDataKeys ??
    makeOwnerDataKeyStore(database, protection, {
      defaultTimeZone,
      defaultLocale,
      defaultHourCycle,
      now
    })

  async function owner(ownerId: string): Promise<typeof users.$inferSelect> {
    const [result] = await database.select().from(users).where(eq(users.id, ownerId)).limit(1)
    if (result === undefined) throw new Error("Owner settings are unavailable")
    return result
  }

  async function get(ownerId: string): Promise<OwnerSettings> {
    await ownerDataKeys.load(ownerId)
    const storedOwner = await owner(ownerId)
    return {
      timeZone: storedOwner.timeZone,
      locale: storedOwner.locale,
      hourCycle: storedOwner.hourCycle,
      updatedAt: storedOwner.updatedAt
    }
  }

  return {
    get,

    async update(ownerId, input, idempotencyKey) {
      if (
        input.timeZone === undefined &&
        input.locale === undefined &&
        input.hourCycle === undefined
      ) {
        throw new Error("At least one owner setting is required")
      }
      await ownerDataKeys.ensure(ownerId)
      const effect: EffectIdentity = {
        ownerId,
        kind: "owner_settings_update",
        idempotencyKey
      }
      if ((await completedEffect(database, effect)) !== undefined) return get(ownerId)

      const at = now().toISOString()
      const values: OwnerSettingsValues = { updatedAt: at }
      if (input.timeZone !== undefined) values.timeZone = canonicalTimeZone(input.timeZone)
      if (input.locale !== undefined) values.locale = canonicalLocale(input.locale)
      if (input.hourCycle !== undefined) values.hourCycle = input.hourCycle
      try {
        await database.batch([
          database.update(users).set(values).where(eq(users.id, ownerId)),
          completeEffect(database, effect, "owner_settings", randomUuid(), at)
        ])
      } catch (error) {
        await completedEffectAfterConflict(database, effect, error)
      }
      return get(ownerId)
    },

    async connections(ownerId) {
      const [channel] = await database
        .select({ id: channels.id, optedOutAt: channels.optedOutAt })
        .from(channels)
        .where(and(eq(channels.userId, ownerId), eq(channels.provider, options.channelProviderId)))
        .limit(1)
      return [
        {
          provider: options.channelProviderId,
          status:
            channel === undefined
              ? "not_connected"
              : channel.optedOutAt === null
                ? "connected"
                : "paused"
        }
      ]
    }
  }
}

export function ownerSettingsStoreLayer(store: OwnerSettingsStore) {
  return Layer.succeed(OwnerSettingsStore, store)
}
