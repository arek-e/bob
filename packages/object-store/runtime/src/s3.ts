import {
  DeleteObjectCommand,
  GetObjectCommand,
  S3ServiceException,
  PutObjectCommand,
  type S3Client
} from "@aws-sdk/client-s3"
import { ObjectStorage, ObjectStorageError, validatedObjectKey } from "@bob/object-store-types"
import { Effect, Layer } from "effect"

export interface S3ObjectStorageOptions {
  readonly bucket: string
  readonly client: Pick<S3Client, "send">
  readonly keyPrefix?: string
}

function objectKey(prefix: string | undefined, key: string): string {
  const validKey = validatedObjectKey(key)
  if (prefix === undefined || prefix.length === 0) return validKey
  return `${prefix.replace(/^\/+|\/+$/g, "")}/${validKey}`
}

export function s3ObjectStorageLayer(options: S3ObjectStorageOptions) {
  if (options.bucket.length === 0) throw new TypeError("S3 bucket is required")
  return Layer.succeed(
    ObjectStorage,
    ObjectStorage.of({
      get: Effect.fnUntraced(function* (key: string) {
        return yield* Effect.tryPromise({
          try: async () => {
            try {
              const result = await options.client.send(
                new GetObjectCommand({
                  Bucket: options.bucket,
                  Key: objectKey(options.keyPrefix, key)
                })
              )
              if (result.Body === undefined) return undefined
              const stored = { body: new Uint8Array(await result.Body.transformToByteArray()) }
              return result.ETag === undefined ? stored : { ...stored, etag: result.ETag }
            } catch (error) {
              if (error instanceof S3ServiceException && error.$metadata.httpStatusCode === 404) {
                return undefined
              }
              throw error
            }
          },
          catch: (cause) => new ObjectStorageError({ operation: "get", cause })
        })
      }),
      put: Effect.fnUntraced(function* (key: string, body: Uint8Array) {
        yield* Effect.tryPromise({
          try: () =>
            options.client.send(
              new PutObjectCommand({
                Bucket: options.bucket,
                Key: objectKey(options.keyPrefix, key),
                Body: body
              })
            ),
          catch: (cause) => new ObjectStorageError({ operation: "put", cause })
        })
      }),
      delete: Effect.fnUntraced(function* (key: string) {
        yield* Effect.tryPromise({
          try: () =>
            options.client.send(
              new DeleteObjectCommand({
                Bucket: options.bucket,
                Key: objectKey(options.keyPrefix, key)
              })
            ),
          catch: (cause) => new ObjectStorageError({ operation: "delete", cause })
        })
      })
    })
  )
}
