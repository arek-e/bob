import { describe, expect, it, vi } from "vitest"

import { OpenBaoCredentialStore } from "../src/openbao-credential-store.ts"

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
      if (url.includes("/auth/kubernetes/login")) {
        return Response.json({ auth: { client_token: "vault-token", lease_duration: 300 } })
      }
      if (url.includes("/pi-auth/openrouter")) {
        return new Response(null, { status: 404 })
      }
      return Response.json({ data: { data: credential, metadata: { version: 4 } } })
    })
    const store = new OpenBaoCredentialStore({
      address: "https://bao.example",
      fixedOwnerId: "00000000-0000-4000-8000-000000000001",
      kubernetesRole: "bob",
      getKubernetesJwt: async () => "jwt",
      fetch: request
    })
    await expect(store.list()).resolves.toEqual([{ providerId: "openai-codex", type: "oauth" }])
    expect(JSON.stringify(await store.list())).not.toContain("access")
    expect(request).toHaveBeenCalledWith(
      "https://bao.example/v1/ops/data/apps/prod/bob/owners/00000000-0000-4000-8000-000000000001/pi-auth/openai-codex",
      expect.any(Object)
    )
  })

  it("authenticates with AppRole without putting the secret ID in the URL", async () => {
    const request = vi.fn<typeof fetch>(async (input) => {
      if (String(input).includes("/auth/approle/login")) {
        return Response.json({ auth: { client_token: "vault-token", lease_duration: 300 } })
      }
      if (String(input).includes("/pi-auth/openrouter")) {
        return new Response(null, { status: 404 })
      }
      return Response.json({ data: { data: credential, metadata: { version: 4 } } })
    })
    const store = new OpenBaoCredentialStore({
      address: "https://bao.example",
      fixedOwnerId: "00000000-0000-4000-8000-000000000001",
      authMethod: "approle",
      appRoleId: "role-id",
      getAppRoleSecretId: async () => "secret-id",
      fetch: request
    })

    await expect(store.read("openai-codex")).resolves.toMatchObject(credential)
    expect(request).toHaveBeenNthCalledWith(
      1,
      "https://bao.example/v1/auth/approle/login",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ role_id: "role-id", secret_id: "secret-id" })
      })
    )
    expect(String(request.mock.calls[0]?.[0])).not.toContain("secret-id")
  })

  it("writes both rotated tokens with KV v2 compare-and-set", async () => {
    const bodies: unknown[] = []
    const request = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input)
      if (url.includes("/auth/kubernetes/login")) {
        return Response.json({ auth: { client_token: "vault-token", lease_duration: 300 } })
      }
      if (url.includes("/pi-auth/openrouter")) {
        return new Response(null, { status: 404 })
      }
      if (init?.method === "POST") {
        // SAFETY: This controlled test fixture matches the asserted contract used by this test.
        bodies.push(JSON.parse(String(init.body)) as unknown)
        return Response.json({ data: {} })
      }
      return Response.json({ data: { data: credential, metadata: { version: 4 } } })
    })
    const store = new OpenBaoCredentialStore({
      address: "https://bao.example",
      fixedOwnerId: "00000000-0000-4000-8000-000000000001",
      kubernetesRole: "bob",
      getKubernetesJwt: async () => "jwt",
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
      if (String(input).includes("/auth/kubernetes/login")) {
        return Response.json({ auth: { client_token: "vault-token", lease_duration: 300 } })
      }
      if (String(input).includes("/pi-auth/openrouter")) {
        return new Response(null, { status: 404 })
      }
      if (init?.method === "POST") writes.push(init.body)
      return Response.json({ data: { data: credential, metadata: { version: 4 } } })
    })
    const store = new OpenBaoCredentialStore({
      address: "https://bao.example",
      fixedOwnerId: "00000000-0000-4000-8000-000000000001",
      kubernetesRole: "bob",
      getKubernetesJwt: async () => "jwt",
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
