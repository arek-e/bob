import type { PrivateObjectStore } from "./index.ts"

import { validatedObjectKey } from "./index.ts"

export interface R2ObjectBody {
  readonly etag: string
  readonly httpMetadata?: { readonly contentType?: string }
  readonly arrayBuffer: () => Promise<ArrayBuffer>
}

export interface R2PutResult {
  readonly etag?: string
}

export interface R2BucketAdapterInput {
  readonly get: (key: string) => Promise<R2ObjectBody | null>
  readonly put: (
    key: string,
    body: Uint8Array,
    options?: { readonly httpMetadata?: { readonly contentType?: string } }
  ) => Promise<R2PutResult>
  readonly delete: (key: string) => Promise<void>
}

export function makeR2PrivateObjectStore(bucket: R2BucketAdapterInput): PrivateObjectStore {
  return {
    async get(key) {
      const value = await bucket.get(validatedObjectKey(key))
      if (value === null) return undefined
      const contentType = value.httpMetadata?.contentType
      return contentType === undefined
        ? { body: new Uint8Array(await value.arrayBuffer()), etag: value.etag }
        : { body: new Uint8Array(await value.arrayBuffer()), etag: value.etag, contentType }
    },
    async put(key, body, options) {
      const contentType = options?.contentType
      await bucket.put(
        validatedObjectKey(key),
        body,
        contentType === undefined ? undefined : { httpMetadata: { contentType } }
      )
    },
    delete: (key) => bucket.delete(validatedObjectKey(key))
  }
}
