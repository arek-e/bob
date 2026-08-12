import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { describe, expect, it } from "vitest"

const execFileAsync = promisify(execFile)

describe("Sendblue reconciler launcher", () => {
  it("initializes varlock/env for the package command", { timeout: 30_000 }, async () => {
    const repositoryRoot = new URL("../../../", import.meta.url)
    const fetchStub = new URL("./fetch-stub.mjs", import.meta.url)
    const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm"

    const result = await execFileAsync(
      pnpm,
      ["--filter", "@bob/sendblue-reconcile", "reconcile", "--", "--check"],
      {
        cwd: repositoryRoot,
        env: {
          ...process.env,
          NODE_OPTIONS: [process.env.NODE_OPTIONS, `--import=${fetchStub.href}`]
            .filter(Boolean)
            .join(" "),
          SENDBLUE_API_KEY_ID: "test-api-key-id",
          SENDBLUE_API_SECRET_KEY: "test-api-secret-key",
          SENDBLUE_WEBHOOK_SIGNING_SECRET: "test-signing-secret",
          SENDBLUE_RECEIVE_WEBHOOK_URL: "https://sendblue.example.test/webhooks/receive",
          SENDBLUE_OUTBOUND_WEBHOOK_URL: "https://sendblue.example.test/webhooks/outbound"
        },
        timeout: 30_000
      }
    )

    expect(result.stderr).not.toContain("varlock ENV not initialized")
    expect(result.stdout).toContain(
      '{"mode":"check","valid":true,"secretMatches":true,"receiveCount":1,"outboundCount":1,"additions":[]}'
    )
  })
})
