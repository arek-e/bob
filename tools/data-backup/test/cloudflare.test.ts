import { describe, expect, it } from "vitest"

import { makeCloudflareBackupSource } from "../src/cloudflare.ts"

function json(value: unknown): Response {
  return Response.json({ success: true, result: [{ success: true, results: value }] })
}

describe("Cloudflare backup source", () => {
  it("exports safely quoted camel-case SQL identifiers", async () => {
    const fetchStub: typeof fetch = async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init)
      const url = new URL(request.url)
      if (url.hostname === "api.cloudflare.com") {
        const body = (await request.json()) as {
          readonly sql?: string
          readonly batch?: readonly { readonly sql: string }[]
        }
        if (body.sql?.includes("sqlite_schema") === true) return json([{ name: "rateLimit" }])
        expect(body.batch?.[0]?.sql).toBe('SELECT * FROM "rateLimit" ORDER BY rowid')
        return Response.json({
          success: true,
          result: [
            {
              success: true,
              results: [{ id: "limit", lastRequest: 1_786_464_000_000 }]
            }
          ]
        })
      }
      return new Response("<ListBucketResult><IsTruncated>false</IsTruncated></ListBucketResult>", {
        status: 200,
        headers: { "content-type": "application/xml" }
      })
    }
    const source = makeCloudflareBackupSource({
      accountId: "account",
      databaseId: "database",
      apiToken: "read-only-token",
      r2Bucket: "bucket",
      r2Endpoint: "https://account.r2.cloudflarestorage.com",
      r2AccessKeyId: "access",
      r2SecretAccessKey: "secret",
      fetch: fetchStub
    })

    await expect(source.export()).resolves.toMatchObject({
      tables: [{ name: "rateLimit", rows: [{ id: "limit", lastRequest: 1_786_464_000_000 }] }]
    })
  })

  it("exports primary D1 tables and R2 objects without derived search projections", async () => {
    const requests: string[] = []
    const fetchStub: typeof fetch = async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init)
      const url = new URL(request.url)
      requests.push(`${request.method} ${url.pathname}${url.search}`)
      if (url.hostname === "api.cloudflare.com") {
        const body = (await request.json()) as {
          readonly sql?: string
          readonly batch?: readonly { readonly sql: string }[]
        }
        if (body.sql?.includes("sqlite_schema") === true) {
          return json([
            { name: "search_documents" },
            { name: "search_documents_fts" },
            { name: "users" }
          ])
        }
        if (body.batch?.[0]?.sql.includes('FROM "users"') === true) {
          return Response.json({
            success: true,
            result: [
              {
                success: true,
                results: [{ id: "owner", time_zone: "Europe/Stockholm" }]
              }
            ]
          })
        }
        throw new Error(`Unexpected D1 query: ${JSON.stringify(body)}`)
      }
      if (url.searchParams.get("list-type") === "2") {
        return new Response(
          "<ListBucketResult><IsTruncated>false</IsTruncated><Contents><Key>journal%2Fone.txt</Key><ETag>&quot;etag&quot;</ETag></Contents></ListBucketResult>",
          { status: 200, headers: { "content-type": "application/xml" } }
        )
      }
      if (url.pathname.endsWith("/bucket/journal/one.txt")) {
        return new Response("encrypted object", {
          status: 200,
          headers: { "content-type": "application/octet-stream" }
        })
      }
      throw new Error(`Unexpected request: ${request.url}`)
    }
    const times = [new Date("2026-08-11T12:00:00.000Z"), new Date("2026-08-11T12:00:01.000Z")]
    const source = makeCloudflareBackupSource({
      accountId: "account",
      databaseId: "database",
      apiToken: "read-only-token",
      r2Bucket: "bucket",
      r2Endpoint: "https://account.r2.cloudflarestorage.com",
      r2AccessKeyId: "access",
      r2SecretAccessKey: "secret",
      fetch: fetchStub,
      now: () => times.shift() ?? new Date("2026-08-11T12:00:01.000Z")
    })

    const archive = await source.export()

    expect(archive.tables.map((table) => table.name)).toEqual(["users"])
    expect(archive.tables[0]?.rows).toEqual([{ id: "owner", time_zone: "Europe/Stockholm" }])
    expect(archive.objects).toMatchObject([
      {
        key: "journal/one.txt",
        etag: "etag",
        contentType: "application/octet-stream"
      }
    ])
    expect(Buffer.from(archive.objects[0]!.bytesBase64, "base64").toString("utf8")).toBe(
      "encrypted object"
    )
    expect(requests.some((value) => value.includes("search_documents"))).toBe(false)
    expect(requests.filter((value) => value.endsWith("/query"))).toHaveLength(2)
  })

  it("fails closed when D1 returns an invalid result", async () => {
    const source = makeCloudflareBackupSource({
      accountId: "account",
      databaseId: "database",
      apiToken: "read-only-token",
      r2Bucket: "bucket",
      r2Endpoint: "https://account.r2.cloudflarestorage.com",
      r2AccessKeyId: "access",
      r2SecretAccessKey: "secret",
      fetch: async () => Response.json({ success: false, errors: [{ message: "denied" }] })
    })

    await expect(source.export()).rejects.toThrow("D1 backup query returned an invalid result")
  })

  it("stops a D1 request that exceeds its time limit", async () => {
    const fetchStub: typeof fetch = async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init)
      return new Promise<Response>((_resolve, reject) => {
        const rejectOnAbort = () => reject(request.signal.reason)
        if (request.signal.aborted) rejectOnAbort()
        else request.signal.addEventListener("abort", rejectOnAbort, { once: true })
      })
    }
    const source = makeCloudflareBackupSource({
      accountId: "account",
      databaseId: "database",
      apiToken: "read-only-token",
      r2Bucket: "bucket",
      r2Endpoint: "https://account.r2.cloudflarestorage.com",
      r2AccessKeyId: "access",
      r2SecretAccessKey: "secret",
      fetch: fetchStub,
      requestTimeoutMs: 10
    })

    await expect(source.export()).rejects.toThrow(/timeout/iu)
  }, 250)

  it("stops an R2 request that exceeds its time limit", async () => {
    const fetchStub: typeof fetch = async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init)
      if (new URL(request.url).hostname === "api.cloudflare.com") {
        return json([])
      }
      return new Promise<Response>((_resolve, reject) => {
        const rejectOnAbort = () => reject(request.signal.reason)
        if (request.signal.aborted) rejectOnAbort()
        else request.signal.addEventListener("abort", rejectOnAbort, { once: true })
      })
    }
    const source = makeCloudflareBackupSource({
      accountId: "account",
      databaseId: "database",
      apiToken: "read-only-token",
      r2Bucket: "bucket",
      r2Endpoint: "https://account.r2.cloudflarestorage.com",
      r2AccessKeyId: "access",
      r2SecretAccessKey: "secret",
      fetch: fetchStub,
      requestTimeoutMs: 10
    })

    await expect(source.export()).rejects.toThrow(/timeout/iu)
  }, 250)
})
