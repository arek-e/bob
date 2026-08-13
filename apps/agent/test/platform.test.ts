import { readFile } from "node:fs/promises"
import { describe, expect, it } from "vitest"

import { AGENT_LISTEN_HOST } from "../src/listener.ts"

describe("agent platform contract", () => {
  it("listens on the container network for service and probe traffic", async () => {
    expect(AGENT_LISTEN_HOST).toBe("0.0.0.0")
    const dockerfile = await readFile("apps/agent/Dockerfile", "utf8")
    expect(dockerfile).toContain("EXPOSE 8787")
  })

  it("uses AppRole for portable OpenBao authentication", async () => {
    const composition = await readFile("apps/agent/src/composition.ts", "utf8")
    const auth = await readFile("packages/pi-agent/src/auth.ts", "utf8")
    const schema = await readFile("apps/agent/.env.schema", "utf8")

    expect(composition).toContain("new OpenBaoCredentialStore")
    expect(composition).toContain("getAppRoleSecretId")
    expect(composition).toContain("baoAppRoleRoleId")
    expect(auth).toContain('options.authMount ?? "approle"')
    expect(auth).toContain("role_id")
    expect(auth).toContain("secret_id")
    expect(schema).toContain("BAO_APPROLE_ROLE_ID")
    expect(schema).toContain("BAO_APPROLE_SECRET_ID")
    expect(schema).not.toContain("KUBERNETES")
  })

  it("builds a bounded production image from the bundled agent", async () => {
    const dockerfile = await readFile("apps/agent/Dockerfile", "utf8")
    const dockerignore = await readFile(".dockerignore", "utf8")
    const packageManifest = await readFile("apps/agent/package.json", "utf8")
    const piAgentSource = await readFile("packages/pi-agent/src/index.ts", "utf8")

    expect(dockerfile).not.toContain("COPY --from=build --chown=node:node /app /app")
    expect(dockerfile).toContain("COPY --from=build --chown=node:node /runtime /app")
    expect(dockerfile).toContain("dist/index.cjs")
    expect(dockerfile).not.toContain("dist/index.js")
    expect(dockerfile).toContain("apps/agent/src/environment.generated.ts")
    expect(packageManifest).toContain(
      '"start": "varlock run --inject vars --skip-cache -- node dist/index.cjs"'
    )
    expect(packageManifest).toMatch(/"varlock": "1\.16\.1"/u)
    expect(packageManifest).not.toContain("tsx src/index.ts")
    expect(packageManifest).toContain("--format=cjs")
    expect(dockerignore).toContain(".varlock/*")
    expect(dockerignore).toContain("!.varlock/config.json")
    expect(dockerignore).toContain("!**/.env.schema")
    expect(piAgentSource).toContain("registerBunOAuthFlows()")
    expect(packageManifest).toContain("verify-agent-bundle.mjs")
  })

  it("does not regenerate TypeScript files during read-only startup", async () => {
    const schema = await readFile("apps/agent/.env.schema", "utf8")

    expect(schema).toContain(
      "@generateTsTypes(path=./src/environment.generated.ts, exposeEnv=local, auto=false)"
    )
  })
})
