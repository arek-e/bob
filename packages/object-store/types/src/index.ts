import { Context, type Effect, Schema } from "effect"

export interface StoredPrivateObject {
  readonly body: Uint8Array
  readonly etag?: string
}

export class ObjectStorageError extends Schema.TaggedError<ObjectStorageError>()(
  "ObjectStorageError",
  {
    operation: Schema.Literals(["get", "put", "delete"]),
    cause: Schema.Unknown
  }
) {}

export interface ObjectStorageShape {
  /** Return undefined only when the key does not exist. */
  readonly get: (key: string) => Effect.Effect<StoredPrivateObject | undefined, ObjectStorageError>
  /** Atomically replace the value stored at the key. */
  readonly put: (key: string, body: Uint8Array) => Effect.Effect<void, ObjectStorageError>
  /** Succeed when the key does not exist. */
  readonly delete: (key: string) => Effect.Effect<void, ObjectStorageError>
}

export class ObjectStorage extends Context.Service<ObjectStorage, ObjectStorageShape>()(
  "@bob/object-storage/ObjectStorage"
) {}

export function validatedObjectKey(key: string): string {
  if (
    key.length < 1 ||
    key.length > 512 ||
    key.startsWith("/") ||
    key.endsWith("/") ||
    key.includes("\\") ||
    key.split("/").some((part) => part.length === 0 || part === "." || part === "..")
  ) {
    throw new TypeError("Private object key is invalid")
  }
  return key
}
