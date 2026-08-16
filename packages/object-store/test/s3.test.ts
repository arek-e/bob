import {
  S3ServiceException,
  type DeleteObjectCommand,
  type GetObjectCommand,
  type PutObjectCommand
} from "@aws-sdk/client-s3"
import { describe, expect, it } from "vitest"

import { makeS3PrivateObjectStore } from "../src/s3.ts"

describe("S3 private object store", () => {
  it("maps the private object Interface to S3 commands", async () => {
    type ObjectCommand = DeleteObjectCommand | GetObjectCommand | PutObjectCommand
    const commands: ObjectCommand[] = []
    // SAFETY: This test double implements the only S3Client method used by the Adapter.
    const client = {
      async send(command: ObjectCommand) {
        commands.push(command)
        if (command.constructor.name === "GetObjectCommand") {
          return {
            Body: { transformToByteArray: async () => new Uint8Array([1, 2]) },
            ContentType: "application/octet-stream",
            ETag: "etag"
          }
        }
        return {}
      }
    } as never
    const store = makeS3PrivateObjectStore({
      bucket: "private",
      keyPrefix: "bob",
      client
    })

    await store.put("owners/one", new Uint8Array([1]), { contentType: "text/plain" })
    await expect(store.get("owners/one")).resolves.toEqual({
      body: new Uint8Array([1, 2]),
      contentType: "application/octet-stream",
      etag: "etag"
    })
    await store.delete("owners/one")

    expect(commands.map((command) => command!.constructor.name)).toEqual([
      "PutObjectCommand",
      "GetObjectCommand",
      "DeleteObjectCommand"
    ])
    expect(commands[0]?.input).toMatchObject({
      Bucket: "private",
      Key: "bob/owners/one",
      ContentType: "text/plain"
    })
  })

  it("returns undefined for a missing object", async () => {
    // SAFETY: This test double exercises the Adapter's provider-error boundary.
    const client = {
      async send() {
        throw new S3ServiceException({
          name: "NoSuchKey",
          $fault: "client",
          $metadata: { httpStatusCode: 404 }
        })
      }
    } as never
    const store = makeS3PrivateObjectStore({
      bucket: "private",
      client
    })
    await expect(store.get("missing")).resolves.toBeUndefined()
  })
})
