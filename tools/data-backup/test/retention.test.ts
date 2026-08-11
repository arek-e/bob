import { describe, expect, it } from "vitest"

import { expiredBackupNames } from "../src/retention.ts"

describe("encrypted backup retention", () => {
  it("keeps the newest matching archives only", () => {
    expect(
      expiredBackupNames(
        [
          "notes.txt",
          ".bob-2026-08-11T16-00-00.000Z.json.gz.age.in-progress.tmp",
          "bob-2026-08-11T08-00-00.000Z.json.gz.age",
          "bob-2026-08-11T12-00-00.000Z.json.gz.age",
          "bob-2026-08-11T04-00-00.000Z.json.gz.age"
        ],
        2
      )
    ).toEqual(["bob-2026-08-11T04-00-00.000Z.json.gz.age"])
  })

  it("rejects a retention count that can delete every backup", () => {
    expect(() => expiredBackupNames([], 0)).toThrow(/positive integer/u)
  })
})
