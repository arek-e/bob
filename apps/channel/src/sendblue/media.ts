import { Effect, Schema } from "effect"

import type { RuntimeFetcher } from "../runtime.ts"

const MAX_IMAGE_BYTES = 5 * 1024 * 1024
const MAX_REDIRECTS = 3

export type SendblueImageMediaType = "image/jpeg" | "image/png"

export interface DownloadedSendblueImage {
  readonly body: Uint8Array
  readonly mediaType: SendblueImageMediaType
}

export class SendblueMediaError extends Schema.TaggedError<SendblueMediaError>()(
  "SendblueMediaError",
  {
    code: Schema.Literals(["invalid_url", "download_failed", "unsupported_media", "too_large"]),
    message: Schema.String
  }
) {}

function validateUrl(value: string, allowedHosts: ReadonlySet<string>): URL {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new SendblueMediaError({ code: "invalid_url", message: "Media URL is invalid" })
  }
  if (
    url.protocol !== "https:" ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    !allowedHosts.has(url.hostname.toLowerCase())
  ) {
    throw new SendblueMediaError({ code: "invalid_url", message: "Media URL is not allowed" })
  }
  return url
}

function mediaType(response: Response): SendblueImageMediaType {
  const value = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase()
  if (value === "image/jpeg" || value === "image/png") return value
  throw new SendblueMediaError({
    code: "unsupported_media",
    message: "Media type is not supported"
  })
}

async function readBoundedBody(response: Response): Promise<Uint8Array> {
  const declaredLength = Number(response.headers.get("content-length") ?? "0")
  if (Number.isFinite(declaredLength) && declaredLength > MAX_IMAGE_BYTES) {
    throw new SendblueMediaError({ code: "too_large", message: "Media is too large" })
  }
  if (response.body === null) return new Uint8Array()
  const chunks: Uint8Array[] = []
  let size = 0
  const reader = response.body.getReader()
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      size += next.value.byteLength
      if (size > MAX_IMAGE_BYTES) {
        await reader.cancel()
        throw new SendblueMediaError({ code: "too_large", message: "Media is too large" })
      }
      chunks.push(next.value)
    }
  } finally {
    reader.releaseLock()
  }
  const body = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }
  return body
}

export function downloadSendblueImage(
  source: string,
  options: {
    readonly fetcher: RuntimeFetcher
    readonly allowedHosts: ReadonlySet<string>
    readonly timeoutMs?: number
  }
) {
  return Effect.tryPromise({
    try: async () => {
      let url = validateUrl(source, options.allowedHosts)
      for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
        const response = await options.fetcher.fetch(url, {
          method: "GET",
          redirect: "manual",
          signal: AbortSignal.timeout(options.timeoutMs ?? 5_000)
        })
        if (response.status >= 300 && response.status < 400) {
          if (redirects === MAX_REDIRECTS) {
            throw new SendblueMediaError({
              code: "download_failed",
              message: "Media has too many redirects"
            })
          }
          const location = response.headers.get("location")
          if (location === null) {
            throw new SendblueMediaError({
              code: "download_failed",
              message: "Media redirect has no location"
            })
          }
          url = validateUrl(new URL(location, url).toString(), options.allowedHosts)
          continue
        }
        if (!response.ok) {
          throw new SendblueMediaError({
            code: "download_failed",
            message: `Media download returned ${response.status}`
          })
        }
        return { body: await readBoundedBody(response), mediaType: mediaType(response) }
      }
      throw new SendblueMediaError({ code: "download_failed", message: "Media download failed" })
    },
    catch: (cause) =>
      cause instanceof SendblueMediaError
        ? cause
        : new SendblueMediaError({ code: "download_failed", message: "Media download failed" })
  })
}
