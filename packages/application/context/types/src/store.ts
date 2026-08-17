import type { PriorToolReceipt } from "@bob/tools-types/receipts"

import { Context, type Effect, Schema } from "effect"

import type { ContextItem } from "./item.ts"
import type { ContextBuildRequest } from "./source.ts"

export interface PriorToolReceiptSource {
  load(input: ContextBuildRequest): Promise<readonly PriorToolReceipt[]>
}

export interface ContextStoreAdapter {
  build(input: ContextBuildRequest | string, channelId?: string): Promise<readonly ContextItem[]>
  priorToolReceipts(input: ContextBuildRequest): Promise<readonly PriorToolReceipt[]>
}

export class ContextStoreError extends Schema.TaggedError<ContextStoreError>()(
  "ContextStoreError",
  { cause: Schema.Unknown }
) {}

export class ContextStore extends Context.Service<
  ContextStore,
  {
    readonly build: (
      input: ContextBuildRequest | string,
      channelId?: string
    ) => Effect.Effect<readonly ContextItem[], ContextStoreError>
    readonly priorToolReceipts: (
      input: ContextBuildRequest
    ) => Effect.Effect<readonly PriorToolReceipt[], ContextStoreError>
  }
>()("@bob/context/ContextStore") {}
