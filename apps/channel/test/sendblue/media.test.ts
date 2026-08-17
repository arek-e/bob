import { Effect } from "effect"
import { describe, expect, it, vi } from "vitest"

import { downloadSendblueImage } from "../../src/sendblue/media.ts"

const hosts = new Set(["media.example.test"])

describe("Sendblue media download", () => {
  it("downloads a bounded image from an approved HTTPS host", async () => {
    const fetcher = {
      fetch: vi.fn(
        async () =>
          new Response(Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), {
            headers: { "content-type": "image/png", "content-length": "8" }
          })
      )
    }
    const image = await Effect.runPromise(
      downloadSendblueImage("https://media.example.test/image.png", {
        fetcher,
        allowedHosts: hosts
      })
    )
    expect(image.mediaType).toBe("image/png")
    expect(image.body).toEqual(Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  })

  it("rejects a redirect to a host outside the allowlist", async () => {
    const fetcher = {
      fetch: vi.fn(
        async () =>
          new Response(null, {
            status: 302,
            headers: { location: "https://attacker.example/image.png" }
          })
      )
    }
    await expect(
      Effect.runPromise(
        downloadSendblueImage("https://media.example.test/image.png", {
          fetcher,
          allowedHosts: hosts
        })
      )
    ).rejects.toThrow("Media URL is not allowed")
  })

  it("rejects an image whose declared size exceeds the limit", async () => {
    const fetcher = {
      fetch: vi.fn(
        async () =>
          new Response(Uint8Array.from([1]), {
            headers: { "content-type": "image/jpeg", "content-length": String(5 * 1024 * 1024 + 1) }
          })
      )
    }
    await expect(
      Effect.runPromise(
        downloadSendblueImage("https://media.example.test/image.jpg", {
          fetcher,
          allowedHosts: hosts
        })
      )
    ).rejects.toThrow("Media is too large")
  })
})
