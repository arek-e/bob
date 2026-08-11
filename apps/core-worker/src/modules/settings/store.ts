import type {
  HourCycle,
  OwnerSettings,
  OwnerSettingsUpdate,
  SettingsConnection
} from "@bob/contracts/settings"

import { and, eq, isNull } from "drizzle-orm"
import { Context, Layer } from "effect"

import type { CoreDatabase } from "../../database.ts"
import type { DataProtection } from "../policy/data-protection.ts"

import { channels, users } from "../conversations/schema.ts"
import {
  completeEffect,
  completedEffect,
  completedEffectAfterConflict,
  type EffectIdentity
} from "../policy/effect-outcome.ts"

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
  readonly defaultLocale?: string
  readonly defaultHourCycle?: HourCycle
  readonly now?: () => Date
  readonly randomUuid?: () => string
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

  async function ensureOwner(ownerId: string): Promise<typeof users.$inferSelect> {
    let [owner] = await database.select().from(users).where(eq(users.id, ownerId)).limit(1)
    if (
      owner !== undefined &&
      owner.wrappedDataKey !== null &&
      owner.wrappedDataKeyIv !== null &&
      owner.dataKeyVersion !== null
    ) {
      return owner
    }

    const created = await protection.createWrappedDataKey()
    const at = now().toISOString()
    if (owner === undefined) {
      await database
        .insert(users)
        .values({
          id: ownerId,
          timeZone: defaultTimeZone,
          locale: defaultLocale,
          hourCycle: defaultHourCycle,
          wrappedDataKey: created.wrapped.ciphertext,
          wrappedDataKeyIv: created.wrapped.iv,
          dataKeyVersion: created.wrapped.version,
          createdAt: at,
          updatedAt: at
        })
        .onConflictDoNothing()
    } else {
      await database
        .update(users)
        .set({
          wrappedDataKey: created.wrapped.ciphertext,
          wrappedDataKeyIv: created.wrapped.iv,
          dataKeyVersion: created.wrapped.version,
          updatedAt: at
        })
        .where(and(eq(users.id, ownerId), isNull(users.wrappedDataKey)))
    }

    ;[owner] = await database.select().from(users).where(eq(users.id, ownerId)).limit(1)
    if (
      owner === undefined ||
      owner.wrappedDataKey === null ||
      owner.wrappedDataKeyIv === null ||
      owner.dataKeyVersion === null
    ) {
      throw new Error("Owner settings are unavailable")
    }
    return owner
  }

  async function get(ownerId: string): Promise<OwnerSettings> {
    const owner = await ensureOwner(ownerId)
    return {
      timeZone: owner.timeZone,
      locale: owner.locale,
      hourCycle: owner.hourCycle,
      updatedAt: owner.updatedAt
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
      await ensureOwner(ownerId)
      const effect: EffectIdentity = {
        ownerId,
        kind: "owner_settings_update",
        idempotencyKey
      }
      if ((await completedEffect(database, effect)) !== undefined) return get(ownerId)

      const at = now().toISOString()
      const values = {
        ...(input.timeZone === undefined ? {} : { timeZone: canonicalTimeZone(input.timeZone) }),
        ...(input.locale === undefined ? {} : { locale: canonicalLocale(input.locale) }),
        ...(input.hourCycle === undefined ? {} : { hourCycle: input.hourCycle }),
        updatedAt: at
      }
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
        .where(and(eq(channels.userId, ownerId), eq(channels.provider, "sendblue")))
        .limit(1)
      return [
        {
          provider: "sendblue",
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
