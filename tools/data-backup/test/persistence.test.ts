import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

import { writeEncryptedBackup } from "../src/persistence.ts"

describe("encrypted backup file persistence", () => {
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
})
