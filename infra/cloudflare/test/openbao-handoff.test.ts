import { describe, expect, it, vi } from "vitest"

import {
  RuntimeCredentialHandoffError,
  safeHandoffFailure,
  selectHandoffIdentity,
  syncRuntimeCredentials,
  type RuntimeCredentials
} from "../src/openbao-handoff.ts"

const runtimeCredentials: RuntimeCredentials = {
  accessTeamDomain: "team.cloudflareaccess.com",
  coreUrl: "https://bob.example.invalid",
  runAudience: "run-audience",
  adminAudience: "admin-audience",
  coreToAgentClientId: "run-client",
  coreToAgentClientSecret: "run-secret",
  coreToAgentAdminClientId: "admin-client",
  coreToAgentAdminClientSecret: "admin-secret",
  agentToCoreClientId: "core-client",
  agentToCoreClientSecret: "core-secret"
}

describe("OpenBao runtime credential handoff", () => {
  it("keeps safe status details and removes unknown error text", () => {
    expect(
      safeHandoffFailure(new RuntimeCredentialHandoffError("runtime record write", 403)).message
    ).toBe("OpenBao runtime record write failed with status 403")
    expect(safeHandoffFailure(new Error("token=do-not-log")).message).toBe(
      "OpenBao runtime credential handoff failed"
    )
  })

  it("writes only the exact production records and returns a content-free result", async () => {
    const requests: Array<{ url: string; init: RequestInit }> = []
    const fetch = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = String(input)
      requests.push({ url, init })
      if (url.startsWith("https://token.actions.example")) {
        return Response.json({ value: "github-oidc" })
      }
      if (url.endsWith("/v1/auth/jwt/login")) {
        return Response.json({ auth: { client_token: "openbao-token" } })
      }
      return new Response(null, { status: 204 })
    })

    const result = await syncRuntimeCredentials(
      runtimeCredentials,
      {
        kind: "github-oidc",
        baoAddress: "https://bao.example.invalid",
        jwtRole: "bob-runtime-handoff",
        oidcRequestUrl: "https://token.actions.example?id=1",
        oidcRequestToken: "request-token"
      },
      fetch
    )

    expect(result).toEqual({ recordsWritten: 3 })
    expect(requests.slice(2, 5).map((request) => request.url)).toEqual([
      "https://bao.example.invalid/v1/ops/data/apps/prod/bob/access/core-to-agent",
      "https://bao.example.invalid/v1/ops/data/apps/prod/bob/access/core-to-agent-admin",
      "https://bao.example.invalid/v1/ops/data/apps/prod/bob/access/agent-to-core"
    ])
    expect(requests.at(-1)?.url).toBe("https://bao.example.invalid/v1/auth/token/revoke-self")
    expect(JSON.stringify(result)).not.toContain("secret")
    expect(requests.slice(2).every((request) => request.init.headers !== undefined)).toBe(true)
  })

  it("uses and revokes one short-lived local child token", async () => {
    const requests: Array<{ url: string; init: RequestInit }> = []
    const fetch = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      requests.push({ url: String(input), init })
      return new Response(null, { status: 204 })
    })

    await expect(
      syncRuntimeCredentials(
        runtimeCredentials,
        {
          kind: "openbao-token",
          baoAddress: "https://bao.example.invalid",
          deployToken: "short-lived-child-token"
        },
        fetch
      )
    ).resolves.toEqual({ recordsWritten: 3 })

    expect(requests).toHaveLength(4)
    expect(requests.slice(0, 3).every(({ url }) => url.includes("/ops/data/apps/prod/bob/"))).toBe(
      true
    )
    expect(requests.at(-1)?.url).toBe("https://bao.example.invalid/v1/auth/token/revoke-self")
    expect(
      requests.every(({ init }) => JSON.stringify(init).includes("short-lived-child-token"))
    ).toBe(true)
  })

  it("revokes the local child token after a failed write", async () => {
    const urls: string[] = []
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      urls.push(url)
      if (url.endsWith("/access/core-to-agent-admin")) {
        return new Response(null, { status: 503 })
      }
      return new Response(null, { status: 204 })
    })

    await expect(
      syncRuntimeCredentials(
        runtimeCredentials,
        {
          kind: "openbao-token",
          baoAddress: "https://bao.example.invalid",
          deployToken: "short-lived-child-token"
        },
        fetch
      )
    ).rejects.toThrow(/write failed/u)
    expect(urls.at(-1)).toBe("https://bao.example.invalid/v1/auth/token/revoke-self")
  })

  it("requires exactly one complete handoff identity", () => {
    const base = { baoAddress: "https://bao.example.invalid" }

    expect(() => selectHandoffIdentity(base)).toThrow(/exactly one/u)
    expect(() =>
      selectHandoffIdentity({ ...base, jwtRole: "role", oidcRequestUrl: "https://oidc.invalid" })
    ).toThrow(/incomplete/u)
    expect(() =>
      selectHandoffIdentity({
        ...base,
        jwtRole: "role",
        oidcRequestUrl: "https://oidc.invalid",
        oidcRequestToken: "oidc-token",
        deployToken: "local-token"
      })
    ).toThrow(/exactly one/u)
  })
})
