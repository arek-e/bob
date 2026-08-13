import { readFile } from "node:fs/promises"
import { describe, expect, it } from "vitest"

import { AGENT_LISTEN_HOST } from "../src/listener.ts"

describe("agent platform contract", () => {
  it("listens on the private container network", () => {
    expect(AGENT_LISTEN_HOST).toBe("0.0.0.0")
  })

  it("uses the OpenBao AppRole secret file in Coolify", async () => {
    const [compose, composition, policy] = await Promise.all([
      readFile("infra/coolify/compose.yaml", "utf8"),
      readFile("apps/agent/src/composition.ts", "utf8"),
      readFile("infra/openbao/agent-production-policy.hcl", "utf8")
    ])
    expect(compose).toContain("BAO_APPROLE_SECRET_ID_PATH: /run/secrets/openbao_approle_secret_id")
    expect(compose).toContain("target: openbao_approle_secret_id")
    expect(compose).not.toContain("BAO_APPROLE_SECRET_ID: ${BAO_APPROLE_SECRET_ID:?}")
    expect(composition).toContain("getAppRoleSecretId")
    expect(policy).toContain('path "ops/data/apps/prod/bob/pi-auth/openai-codex"')
    expect(policy).not.toContain("/access/")
  })

  it("builds a bounded production image", async () => {
    const [dockerfile, dockerignore, packageManifest] = await Promise.all([
      readFile("apps/agent/Dockerfile", "utf8"),
      readFile(".dockerignore", "utf8"),
      readFile("apps/agent/package.json", "utf8")
    ])
    expect(dockerfile).toContain("COPY --from=build --chown=node:node /runtime /app")
    expect(dockerfile).toContain("dist/index.cjs")
    expect(packageManifest).toContain(
      '"start": "varlock run --inject vars --skip-cache -- node dist/index.cjs"'
    )
    expect(dockerignore).toContain("!**/.env.schema")
  })

  it("does not generate source files during startup", async () => {
    const schema = await readFile("apps/agent/.env.schema", "utf8")
    expect(schema).toContain(
      "@generateTsTypes(path=./src/environment.generated.ts, exposeEnv=local, auto=false)"
    )
  })
})
