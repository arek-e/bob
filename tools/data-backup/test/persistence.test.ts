import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"

import { uploadEncryptedBackup, writeEncryptedBackup } from "../src/persistence.ts"

describe("encrypted backup file persistence", () => {
  afterEach(() => vi.unstubAllGlobals())

  it("publishes one complete final archive", async () => {
    const directory = await mkdtemp(join(tmpdir(), "bob-backup-persist-"))
    const filename = "bob-2026-08-11T12-00-00.000Z.json.gz.age"
    const ciphertext = new TextEncoder().encode("encrypted bytes")

    const finalPath = await writeEncryptedBackup({
      outputDirectory: directory,
      filename,
      ciphertext,
      randomUuid: () => "00000000-0000-4000-8000-000000000001"
    })

    expect(finalPath).toBe(join(directory, filename))
    expect(await readdir(directory)).toEqual([filename])
    expect(await readFile(finalPath)).toEqual(Buffer.from(ciphertext))
  })

  it("removes only its temporary file when publication fails", async () => {
    const directory = await mkdtemp(join(tmpdir(), "bob-backup-persist-failure-"))
    const filename = "bob-2026-08-11T12-00-00.000Z.json.gz.age"
    const unrelated = `.${filename}.unrelated.tmp`
    await mkdir(join(directory, filename))
    await writeFile(join(directory, unrelated), "keep")

    await expect(
      writeEncryptedBackup({
        outputDirectory: directory,
        filename,
        ciphertext: new TextEncoder().encode("encrypted bytes"),
        randomUuid: () => "00000000-0000-4000-8000-000000000001"
      })
    ).rejects.toThrow()

    expect((await readdir(directory)).sort()).toEqual([filename, unrelated].sort())
  })

  it("uploads an encrypted archive with an S3 signature", async () => {
    const request = vi.fn<typeof fetch>(async () => new Response(null, { status: 200 }))
    vi.stubGlobal("fetch", request)

    await uploadEncryptedBackup({
      endpoint: "https://s3.example.invalid",
      region: "eu-test-1",
      bucket: "bob-independent",
      prefix: "production/bob",
      filename: "bob-2026-08-11T12-00-00.000Z.json.gz.age",
      ciphertext: new TextEncoder().encode("encrypted bytes"),
      accessKeyId: "fixture-access-key",
      secretAccessKey: "fixture-secret-key"
    })

    const signed = request.mock.calls[0]?.[0]
    expect(signed).toBeInstanceOf(Request)
    expect((signed as Request).url).toBe(
      "https://s3.example.invalid/bob-independent/production/bob/bob-2026-08-11T12-00-00.000Z.json.gz.age"
    )
    expect((signed as Request).headers.get("authorization")).toContain("AWS4-HMAC-SHA256")
    expect((signed as Request).headers.get("x-amz-content-sha256")).toBe("UNSIGNED-PAYLOAD")
  })
})
