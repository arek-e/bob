export interface StoredPrivateObject {
  readonly body: Uint8Array
  readonly contentType?: string
  readonly etag?: string
}

export interface PutPrivateObjectOptions {
  readonly contentType?: string
}

export interface PrivateObjectStore {
  readonly get: (key: string) => Promise<StoredPrivateObject | undefined>
  readonly put: (key: string, body: Uint8Array, options?: PutPrivateObjectOptions) => Promise<void>
  readonly delete: (key: string) => Promise<void>
}

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
