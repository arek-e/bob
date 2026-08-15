import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { describe, expect, it } from "vitest"

const execFileAsync = promisify(execFile)

describe("Pi smoke launcher", () => {
  it("initializes varlock/env for the package command", { timeout: 30_000 }, async () => {
    const repositoryRoot = new URL("../../../", import.meta.url)
    const fetchStub = new URL("./fetch-stub.mjs", import.meta.url)
    const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm"

    const result = await execFileAsync(pnpm, ["--filter", "@bob/pi-smoke", "smoke:auth"], {
      cwd: repositoryRoot,
      env: {
        ...process.env,
        NODE_OPTIONS: [process.env.NODE_OPTIONS, `--import=${fetchStub.href}`]
          .filter(Boolean)
          .join(" "),
        BAO_ADDR: "https://openbao.example.test",
        BAO_JWT_ROLE: "",
        AGENT_URL: "https://agent.example.test",
        AGENT_ADMIN_URL: "https://agent-admin.example.test",
        AGENT_ACCESS_CLIENT_ID: "test-run-client",
        AGENT_ACCESS_CLIENT_SECRET: "test-run-secret",
        AGENT_ADMIN_ACCESS_CLIENT_ID: "test-admin-client",
        AGENT_ADMIN_ACCESS_CLIENT_SECRET: "test-admin-secret"
      },
      timeout: 30_000
    })

    expect(result.stderr).not.toContain("varlock ENV not initialized")
    expect(result.stdout).toContain('{"authentication":"configured","provider":"openai-codex"}')
  })

  it(
    "runs a bounded predeploy suite without printing model text",
    { timeout: 30_000 },
    async () => {
      const repositoryRoot = new URL("../../../", import.meta.url)
      const fetchStub = new URL("./fetch-stub.mjs", import.meta.url)
      const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm"

      const result = await execFileAsync(pnpm, ["--filter", "@bob/pi-smoke", "smoke:predeploy"], {
        cwd: repositoryRoot,
        env: {
          ...process.env,
          NODE_OPTIONS: [process.env.NODE_OPTIONS, `--import=${fetchStub.href}`]
            .filter(Boolean)
            .join(" "),
          BAO_ADDR: "https://openbao.example.test",
          BAO_JWT_ROLE: "",
          AGENT_URL: "https://agent.example.test",
          AGENT_ADMIN_URL: "https://agent-admin.example.test",
          AGENT_ACCESS_CLIENT_ID: "test-run-client",
          AGENT_ACCESS_CLIENT_SECRET: "test-run-secret",
          AGENT_ADMIN_ACCESS_CLIENT_ID: "test-admin-client",
          AGENT_ADMIN_ACCESS_CLIENT_SECRET: "test-admin-secret"
        },
        timeout: 30_000
      })

      expect(result.stderr).not.toContain("varlock ENV not initialized")
      expect(result.stdout).toContain('"predeploy":"completed"')
      expect(result.stdout).toContain('"structured-completion"')
      expect(result.stdout).not.toContain("training")
    }
  )
})
