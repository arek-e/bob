import { coreDeploymentProfile } from "@bob/core-types/profiles"
import { Effect } from "effect"
import { describe, expect, it, vi } from "vitest"

import { createCoreToolClient } from "../src/core-tools.ts"

const runId = "018e6f65-4d55-7a1b-8df4-4ee15ea1dba4"
const attachmentId = "018e6f65-4d55-7a1b-8df4-4ee15ea1dba5"
const body = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

async function contentHash(value: Uint8Array): Promise<string> {
  return Buffer.from(await crypto.subtle.digest("SHA-256", Uint8Array.from(value))).toString(
    "base64"
  )
}

describe("Core attachment client", () => {
  it("loads and verifies an attachment from its run-scoped route", async () => {
    const request = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(body, { headers: { "content-type": "image/png" } })
    )
    const client = createCoreToolClient({
      catalogue: coreDeploymentProfile,
      coreUrl: "https://core.test",
      callerSecret: "secret",
      fetch: request
    })
    const result = await Effect.runPromise(
      client.loadAttachment(runId, {
        id: attachmentId,
        mediaType: "image/png",
        byteLength: body.byteLength,
        contentHash: await contentHash(body)
      })
    )

    expect(result).toEqual({ data: Buffer.from(body).toString("base64"), mimeType: "image/png" })
    expect(String(request.mock.calls[0]?.[0])).toContain(
      `/internal/agent/runs/${runId}/attachments/${attachmentId}`
    )
    expect(new Headers(request.mock.calls[0]?.[1]?.headers).get("x-bob-caller-token")).toBe(
      "secret"
    )
  })

  it("rejects bytes which do not match the immutable run reference", async () => {
    const client = createCoreToolClient({
      catalogue: coreDeploymentProfile,
      coreUrl: "https://core.test",
      callerSecret: "secret",
      fetch: vi.fn(
        async (_input: RequestInfo | URL, _init?: RequestInit) =>
          new Response(body, { headers: { "content-type": "image/png" } })
      )
    })
    await expect(
      Effect.runPromise(
        client.loadAttachment(runId, {
          id: attachmentId,
          mediaType: "image/png",
          byteLength: body.byteLength,
          contentHash: "wrong"
        })
      )
    ).rejects.toMatchObject({ operation: "load_attachment" })
  })
})
