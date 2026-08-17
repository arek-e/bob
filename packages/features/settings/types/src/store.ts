import type { EffectAdapter } from "@bob/shared-types/effect-adapter"

import { Context, Schema } from "effect"

import type { OwnerSettings, OwnerSettingsUpdate, SettingsConnection } from "./settings.ts"

export interface OwnerSettingsStoreAdapter {
  get(ownerId: string): Promise<OwnerSettings>
  update(
    ownerId: string,
    input: OwnerSettingsUpdate,
    idempotencyKey: string
  ): Promise<OwnerSettings>
  connections(ownerId: string): Promise<readonly SettingsConnection[]>
}

export class OwnerSettingsStoreError extends Schema.TaggedError<OwnerSettingsStoreError>()(
  "OwnerSettingsStoreError",
  { operation: Schema.String, cause: Schema.Unknown }
) {}

export class OwnerSettingsStore extends Context.Service<
  OwnerSettingsStore,
  EffectAdapter<OwnerSettingsStoreAdapter, OwnerSettingsStoreError>
>()("@bob/settings/OwnerSettingsStore") {}
