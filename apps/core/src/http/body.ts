import { Data, Schema } from "effect"

const MAX_BODY_BYTES = 64 * 1024
const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024

export class RequestBodyTooLargeError extends Data.TaggedError("RequestBodyTooLargeError") {
  override get message(): string {
    return "body_too_large"
  }
}

export async function readJson(request: Request): Promise<typeof Schema.Json.Type> {
  const declaredLength = Number(request.headers.get("content-length") ?? "0")
  if (declaredLength > MAX_BODY_BYTES) throw new RequestBodyTooLargeError()
  const bytes = new Uint8Array(await request.arrayBuffer())
  if (bytes.byteLength > MAX_BODY_BYTES) throw new RequestBodyTooLargeError()
  return Schema.decodeUnknownSync(Schema.Json)(JSON.parse(new TextDecoder().decode(bytes)))
}

export async function readAttachmentBytes(request: Request): Promise<Uint8Array> {
  const declaredLength = Number(request.headers.get("content-length") ?? "0")
  if (declaredLength > MAX_ATTACHMENT_BYTES) throw new Error("body_too_large")
  const bytes = new Uint8Array(await request.arrayBuffer())
  if (bytes.byteLength > MAX_ATTACHMENT_BYTES) throw new Error("body_too_large")
  return bytes
}

export function idempotencyKey(request: Request): string {
  const value = request.headers.get("idempotency-key")
  if (value === null || value.length < 8 || value.length > 200) {
    throw new Error("A valid idempotency key is required")
  }
  return value
}
