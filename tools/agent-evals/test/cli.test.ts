import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { describe, expect, it } from "vitest"

const execFileAsync = promisify(execFile)

describe("agent evaluation command", () => {
  it(
    "reports public benchmark coverage without fabricated scores",
    { timeout: 30_000 },
    async () => {
      const repositoryRoot = new URL("../../../", import.meta.url)
      const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm"

      const result = await execFileAsync(
        pnpm,
        ["--silent", "--filter", "@bob/agent-evals", "eval:benchmarks", "--", "--json"],
        { cwd: repositoryRoot, timeout: 30_000 }
      )
      // SAFETY: This controlled test fixture matches the asserted contract used by this test.
      const report = JSON.parse(result.stdout) as {
        readonly officialScores: { readonly recorded: number; readonly total: number }
        readonly benchmarks: readonly unknown[]
      }

      expect(report.officialScores).toEqual({ recorded: 0, total: 4 })
      expect(report.benchmarks).toHaveLength(9)
    }
  )

  it("runs the offline synthetic gate from the repository root", { timeout: 30_000 }, async () => {
    const repositoryRoot = new URL("../../../", import.meta.url)
    const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm"

    const result = await execFileAsync(
      pnpm,
      ["--silent", "--filter", "@bob/agent-evals", "eval:offline", "--", "--json"],
      { cwd: repositoryRoot, timeout: 30_000 }
    )
    // SAFETY: This controlled test fixture matches the asserted contract used by this test.
    const report = JSON.parse(result.stdout) as {
      readonly passed: boolean
      readonly cases: { readonly passed: number; readonly total: number }
    }

    expect(report.passed).toBe(true)
    expect(report.cases).toEqual({ passed: 11, total: 11 })
  })

  it("runs the personal-agent interaction gate", { timeout: 30_000 }, async () => {
    const repositoryRoot = new URL("../../../", import.meta.url)
    const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm"

    const result = await execFileAsync(
      pnpm,
      ["--silent", "--filter", "@bob/agent-evals", "eval:interaction", "--", "--json"],
      { cwd: repositoryRoot, timeout: 30_000 }
    )
    // SAFETY: This controlled test fixture matches the asserted contract used by this test.
    const report = JSON.parse(result.stdout) as {
      readonly passed: boolean
      readonly schemaVersion: number
      readonly cases: { readonly passed: number; readonly total: number }
    }

    expect(report.passed).toBe(true)
    expect(report.schemaVersion).toBe(2)
    expect(report.cases).toEqual({ passed: 12, total: 12 })
  })

  it("compares an interaction candidate with its baseline", { timeout: 30_000 }, async () => {
    const repositoryRoot = new URL("../../../", import.meta.url)
    const suite = new URL("evals/scenarios/v2/interaction-cases.json", repositoryRoot)
    const fixture = new URL("evals/fixtures/v2/offline-candidates.json", repositoryRoot)
    const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm"

    const result = await execFileAsync(
      pnpm,
      [
        "--silent",
        "--filter",
        "@bob/agent-evals",
        "eval:compare",
        "--",
        "--suite",
        suite.pathname,
        "--baseline",
        fixture.pathname,
        "--candidates",
        fixture.pathname,
        "--json"
      ],
      { cwd: repositoryRoot, timeout: 30_000 }
    )
    // SAFETY: This controlled test fixture matches the asserted contract used by this test.
    const comparison = JSON.parse(result.stdout) as {
      readonly passed: boolean
      readonly regressedCases: readonly string[]
    }

    expect(comparison.passed).toBe(true)
    expect(comparison.regressedCases).toEqual([])
  })

  it("does not start a live adapter without explicit approval", { timeout: 30_000 }, async () => {
    const repositoryRoot = new URL("../../../", import.meta.url)
    const adapter = new URL("./fixtures/live-adapter.mjs", import.meta.url)
    const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm"

    await expect(
      execFileAsync(
        pnpm,
        [
          "--silent",
          "--filter",
          "@bob/agent-evals",
          "eval:live",
          "--",
          "--adapter",
          process.execPath,
          "--adapter-arg",
          adapter.pathname
        ],
        { cwd: repositoryRoot, timeout: 30_000 }
      )
    ).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining("live_evaluation_not_approved")
    })
  })

  it(
    "runs three safe live cases through an explicitly approved adapter",
    { timeout: 30_000 },
    async () => {
      const repositoryRoot = new URL("../../../", import.meta.url)
      const adapter = new URL("./fixtures/live-adapter.mjs", import.meta.url)
      const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm"

      const result = await execFileAsync(
        pnpm,
        [
          "--silent",
          "--filter",
          "@bob/agent-evals",
          "eval:live",
          "--",
          "--approve-live",
          "--adapter",
          process.execPath,
          "--adapter-arg",
          adapter.pathname,
          "--json"
        ],
        { cwd: repositoryRoot, timeout: 30_000 }
      )
      // SAFETY: This controlled test fixture matches the asserted contract used by this test.
      const report = JSON.parse(result.stdout) as {
        readonly passed: boolean
        readonly cases: { readonly passed: number; readonly total: number }
      }

      expect(report.passed).toBe(true)
      expect(report.cases).toEqual({ passed: 3, total: 3 })
    }
  )
})
