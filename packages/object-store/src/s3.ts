import {
  DeleteObjectCommand,
  GetObjectCommand,
  S3ServiceException,
  PutObjectCommand,
  type S3Client
} from "@aws-sdk/client-s3"

import type { PrivateObjectStore } from "./index.ts"

import { validatedObjectKey } from "./index.ts"

export interface S3PrivateObjectStoreOptions {
  readonly bucket: string
  readonly client: Pick<S3Client, "send">
  readonly keyPrefix?: string
}

function objectKey(prefix: string | undefined, key: string): string {
  const validKey = validatedObjectKey(key)
  if (prefix === undefined || prefix.length === 0) return validKey
  return `${prefix.replace(/^\/+|\/+$/g, "")}/${validKey}`
}

export function makeS3PrivateObjectStore(options: S3PrivateObjectStoreOptions): PrivateObjectStore {
  if (options.bucket.length === 0) throw new TypeError("S3 bucket is required")
  return {
    async get(key) {
      try {
        const result = await options.client.send(
          new GetObjectCommand({ Bucket: options.bucket, Key: objectKey(options.keyPrefix, key) })
        )
        if (result.Body === undefined) return undefined
        const body = await result.Body.transformToByteArray()
        const storedBody = new Uint8Array(body)
        if (result.ContentType !== undefined && result.ETag !== undefined) {
          return { body: storedBody, contentType: result.ContentType, etag: result.ETag }
        }
        if (result.ContentType !== undefined)
          return { body: storedBody, contentType: result.ContentType }
        if (result.ETag !== undefined) return { body: storedBody, etag: result.ETag }
        return { body: storedBody }
      } catch (error) {
        if (error instanceof S3ServiceException && error.$metadata.httpStatusCode === 404) {
          return undefined
        }
        throw error
      }
    },
    async put(key, body, putOptions) {
      await options.client.send(
        new PutObjectCommand({
          Bucket: options.bucket,
          Key: objectKey(options.keyPrefix, key),
          Body: body,
          ContentType: putOptions?.contentType
        })
      )
    },
    async delete(key) {
      await options.client.send(
        new DeleteObjectCommand({ Bucket: options.bucket, Key: objectKey(options.keyPrefix, key) })
      )
    }
  }
}
