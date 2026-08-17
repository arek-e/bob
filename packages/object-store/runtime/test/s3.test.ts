import {
  DeleteObjectCommand,
  GetObjectCommand,
  NoSuchKey,
  PutObjectCommand
} from "@aws-sdk/client-s3"
import { ManagedRuntime } from "effect"

import { s3ObjectStorageLayer } from "../src/s3.ts"
import { objectStorageConformance } from "./conformance.ts"

objectStorageConformance("S3", async () => {
  const objects = new Map<string, Uint8Array>()
  const client = {
    async send(command: DeleteObjectCommand | GetObjectCommand | PutObjectCommand) {
      const key = String(command.input.Key)
      if (command instanceof PutObjectCommand) {
        objects.set(key, new Uint8Array(command.input.Body as Uint8Array))
        return { ETag: "stored" }
      }
      if (command instanceof DeleteObjectCommand) {
        objects.delete(key)
        return {}
      }
      const body = objects.get(key)
      if (body === undefined) {
        throw new NoSuchKey({ message: "missing", $metadata: { httpStatusCode: 404 } })
      }
      return {
        Body: { transformToByteArray: async () => body },
        ETag: "stored"
      }
    }
  } as never
  const runtime = ManagedRuntime.make(
    s3ObjectStorageLayer({ bucket: "private", keyPrefix: "bob", client })
  )
  return {
    run: (effect) => runtime.runPromise(effect),
    dispose: () => runtime.dispose()
  }
})
