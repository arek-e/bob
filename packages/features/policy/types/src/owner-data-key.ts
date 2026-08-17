import type { EffectAdapter } from "@bob/shared-types/effect-adapter"

import { Context, Schema } from "effect"

export interface OwnerDataKey {
  readonly key: CryptoKey
  readonly version: number
}

export interface OwnerDataKeyStoreAdapter {
  load(ownerId: string): Promise<OwnerDataKey>
  ensure(ownerId: string): Promise<OwnerDataKey>
}

export class OwnerDataKeyStoreError extends Schema.TaggedError<OwnerDataKeyStoreError>()(
  "OwnerDataKeyStoreError",
  { operation: Schema.String, cause: Schema.Unknown }
) {}

export class OwnerDataKeyStore extends Context.Service<
  OwnerDataKeyStore,
  EffectAdapter<OwnerDataKeyStoreAdapter, OwnerDataKeyStoreError>
>()("@bob/policy/OwnerDataKeyStore") {}

export interface OwnerDataKeyStoreOptions {
  readonly defaultTimeZone: string
  readonly defaultLocale?: string
  readonly defaultHourCycle?: "auto" | "h12" | "h23"
  readonly now?: () => Date
}
