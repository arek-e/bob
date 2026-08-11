import { describe, expect, it } from "vitest"

import { readAgentConfiguration } from "../src/configuration.ts"

describe("agent configuration", () => {
  it("decodes process environment strings", () => {
    const configuration = readAgentConfiguration({
      PORT: "8787",
      BAO_ADDR: "https://openbao.example.invalid/",
      BAO_KUBERNETES_ROLE: "bob-agent",
      BAO_KUBERNETES_JWT_PATH: "/var/run/secrets/kubernetes.io/serviceaccount/token",
      BOB_PROVIDER: "openai-codex",
      BOB_MODEL: "gpt-5.6-luna",
      BOB_ALLOWED_MODELS: "gpt-5.6-luna,gpt-5.6-terra",
      CORE_URL: "https://bob.example.invalid/",
      CORE_ACCESS_CLIENT_ID: "fixture-client-id",
      CORE_ACCESS_CLIENT_SECRET: "fixture-client-value",
      ACCESS_TEAM_DOMAIN: "team.cloudflareaccess.com",
      RUN_ACCESS_AUDIENCE: "fixture-run-audience",
      RUN_ACCESS_SUBJECT: "fixture-run-subject",
      ADMIN_ACCESS_AUDIENCE: "fixture-admin-audience",
      ADMIN_ACCESS_SUBJECT: "fixture-admin-subject"
    })

    expect(configuration.baoAddress).toBe("https://openbao.example.invalid")
    expect(configuration.coreUrl).toBe("https://bob.example.invalid")
    expect(configuration.port).toBe(8787)
    expect(configuration.allowedModels).toEqual(["gpt-5.6-luna", "gpt-5.6-terra"])
  })
})
