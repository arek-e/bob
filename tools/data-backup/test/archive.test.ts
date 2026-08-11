import { generateIdentity, identityToRecipient } from "age-encryption"
import { describe, expect, it } from "vitest"

import {
  createArchive,
  decryptArchive,
  encryptArchive,
  tableHash,
  validateArchive
} from "../src/archive.ts"

describe("encrypted backup archive", () => {
  it("round-trips primary rows and private objects through age encryption", async () => {
    const identity = await generateIdentity()
    const recipient = await identityToRecipient(identity)
    const rows = [{ id: "one", encrypted_value: "ciphertext" }]
    const bytes = new TextEncoder().encode("private object")
    const archive = createArchive({
      createdAt: "2026-08-11T12:00:01.000Z",
      cutoffStartedAt: "2026-08-11T12:00:00.000Z",
      cutoffFinishedAt: "2026-08-11T12:00:01.000Z",
      source: { accountId: "account", databaseId: "database", bucket: "bucket" },
      tables: [{ name: "facts", rows, sha256: tableHash(rows) }],
      objects: [
        {
          key: "journal/file.txt",
          bytesBase64: Buffer.from(bytes).toString("base64"),
          sha256: "dbb7088df61bbdc46c911abb4a8024365e1552b3b03ea9c23fe4f9ac65aa519e"
        }
      ]
    })

    const encrypted = await encryptArchive(archive, recipient, 1_000_000)
    expect(encrypted).not.toContain(new TextEncoder().encode("private object"))
    await expect(decryptArchive(encrypted, identity)).resolves.toEqual(archive)
  })

  it("rejects changed table content", () => {
    const rows = [{ id: "one" }]
    const archive = createArchive({
      createdAt: "2026-08-11T12:00:01.000Z",
      cutoffStartedAt: "2026-08-11T12:00:00.000Z",
      cutoffFinishedAt: "2026-08-11T12:00:01.000Z",
      source: { accountId: "account", databaseId: "database", bucket: "bucket" },
      tables: [{ name: "facts", rows, sha256: tableHash(rows) }],
      objects: []
    })
    const changed = {
      ...archive,
      tables: [{ ...archive.tables[0]!, rows: [{ id: "changed" }] }]
    }
    expect(() => validateArchive(changed)).toThrow(/table integrity/u)
  })
})
