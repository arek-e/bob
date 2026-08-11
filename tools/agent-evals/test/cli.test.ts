import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { describe, expect, it } from "vitest"

const execFileAsync = promisify(execFile)

describe("agent evaluation command", () => {
  it("runs the offline synthetic gate from the repository root", async () => {
    const repositoryRoot = new URL("../../../", import.meta.url)
    const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm"

    const result = await execFileAsync(
      pnpm,
      ["--silent", "--filter", "@bob/agent-evals", "eval:offline", "--", "--json"],
      { cwd: repositoryRoot, timeout: 30_000 }
    )
    const report = JSON.parse(result.stdout) as {
      readonly passed: boolean
      readonly cases: { readonly passed: number; readonly total: number }
    }

    expect(report.passed).toBe(true)
    expect(report.cases).toEqual({ passed: 11, total: 11 })
  })

  it("does not start a live adapter without explicit approval", async () => {
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

  it("runs three safe live cases through an explicitly approved adapter", async () => {
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
    const report = JSON.parse(result.stdout) as {
      readonly passed: boolean
      readonly cases: { readonly passed: number; readonly total: number }
    }

    expect(report.passed).toBe(true)
    expect(report.cases).toEqual({ passed: 3, total: 3 })
  })
})
