import { describe, expect, it, vi } from "vitest"

import { OpenBaoCredentialStore } from "../src/auth.ts"

const credential = {
  type: "oauth" as const,
  access: "access",
  refresh: "refresh",
  expires: 2_000_000_000_000,
  accountId: "account"
}

describe("OpenBao Pi credential store", () => {
  it("lists metadata without token values", async () => {
    const request = vi.fn<typeof fetch>(async (input) => {
      const url = String(input)
      if (url.includes("/auth/approle/login")) {
        return Response.json({ auth: { client_token: "vault-token", lease_duration: 300 } })
      }
      return Response.json({ data: { data: credential, metadata: { version: 4 } } })
    })
    const store = new OpenBaoCredentialStore({
      address: "https://bao.example",
      appRoleRoleId: "role-id",
      getAppRoleSecretId: async () => "secret-id",
      fetch: request
    })
    await expect(store.list()).resolves.toEqual([{ providerId: "openai-codex", type: "oauth" }])
    expect(JSON.stringify(await store.list())).not.toContain("access")
    expect(request).toHaveBeenCalledWith(
      "https://bao.example/v1/ops/data/apps/prod/bob/pi-auth/openai-codex",
      expect.any(Object)
    )
  })

  it("writes both rotated tokens with KV v2 compare-and-set", async () => {
    const bodies: unknown[] = []
    const request = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input)
      if (url.includes("/auth/approle/login")) {
        return Response.json({ auth: { client_token: "vault-token", lease_duration: 300 } })
      }
      if (init?.method === "POST") {
        bodies.push(JSON.parse(String(init.body)) as unknown)
        return Response.json({ data: {} })
      }
      return Response.json({ data: { data: credential, metadata: { version: 4 } } })
    })
    const store = new OpenBaoCredentialStore({
      address: "https://bao.example",
      appRoleRoleId: "role-id",
      getAppRoleSecretId: async () => "secret-id",
      fetch: request
    })
    await store.modify("openai-codex", async () => ({
      ...credential,
      access: "rotated-access",
      refresh: "rotated-refresh"
    }))
    expect(bodies).toEqual([
      {
        data: { ...credential, access: "rotated-access", refresh: "rotated-refresh" },
        options: { cas: 4 }
      }
    ])
  })

  it("preserves the old version when refresh fails", async () => {
    const writes: unknown[] = []
    const request = vi.fn<typeof fetch>(async (input, init) => {
      if (String(input).includes("/auth/approle/login")) {
        return Response.json({ auth: { client_token: "vault-token", lease_duration: 300 } })
      }
      if (init?.method === "POST") writes.push(init.body)
      return Response.json({ data: { data: credential, metadata: { version: 4 } } })
    })
    const store = new OpenBaoCredentialStore({
      address: "https://bao.example",
      appRoleRoleId: "role-id",
      getAppRoleSecretId: async () => "secret-id",
      fetch: request
    })
    await expect(
      store.modify("openai-codex", async () => {
        throw new Error("refresh failed")
      })
    ).rejects.toThrow("refresh failed")
    expect(writes).toEqual([])
    await expect(store.read("openai-codex")).resolves.toMatchObject(credential)
  })
})
