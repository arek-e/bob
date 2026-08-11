import { applyD1Migrations, reset } from "cloudflare:test"
import { env } from "cloudflare:workers"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import type { CoreBindings } from "../src/bindings.ts"
import type { AccessTokenVerifier } from "../src/modules/policy/access.ts"

import { handleHttp } from "../src/entrypoints/http.ts"
import { decodeTestMigrations } from "./migrations.ts"

declare global {
  namespace Cloudflare {
    interface Env {
      DB: D1Database
      TEST_MIGRATIONS: string
    }
  }
}

const bindings = env as unknown as CoreBindings
const ownerAccess: AccessTokenVerifier = async (_request, configuration) => ({
  subject: "owner-subject",
  email: bindings.OWNER_ACCESS_EMAIL,
  audience: [configuration.accessAudience]
})

function request(path: string, init?: RequestInit): Request {
  return new Request(`${bindings.UI_BASE_URL}${path}`, {
    ...init,
    headers: {
      origin: bindings.UI_BASE_URL,
      "cf-connecting-ip": "192.0.2.1",
      ...init?.headers
    }
  })
}

beforeEach(async () => {
  await applyD1Migrations(env.DB, decodeTestMigrations(env.TEST_MIGRATIONS))
})

afterEach(async () => {
  await reset()
})

describe("owner authentication", () => {
  it("rejects an owner API request without a Better Auth session", async () => {
    const response = await handleHttp(request("/api/settings"), bindings)

    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toEqual({ code: "unauthorized" })
  })

  it("keeps password policy inside the owner auth service", async () => {
    const response = await handleHttp(
      request("/setup/api", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: "too-short" })
      }),
      bindings,
      ownerAccess
    )

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toEqual({ code: "invalid_password" })
  })

  it("fails closed when Better Auth contains another account", async () => {
    const at = Date.now()
    await env.DB.prepare(
      "INSERT INTO `auth_user` (`id`, `name`, `email`, `email_verified`, `created_at`, `updated_at`) VALUES (?, ?, ?, ?, ?, ?)"
    )
      .bind("unexpected-user", "Unexpected", "unexpected@example.invalid", 1, at, at)
      .run()

    const response = await handleHttp(request("/setup/api"), bindings, ownerAccess)

    expect(response.status).toBe(503)
    await expect(response.json()).resolves.toEqual({ code: "setup_unavailable" })
  })

  it("bootstraps one owner login and uses its session for owner APIs", async () => {
    const initial = await handleHttp(request("/setup/api"), bindings, ownerAccess)
    await expect(initial.json()).resolves.toEqual({ setupRequired: true })

    const created = await handleHttp(
      request("/setup/api", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: "correct horse battery staple" })
      }),
      bindings,
      ownerAccess
    )
    expect(created.status).toBe(200)
    const setCookie = created.headers.get("set-cookie")
    expect(setCookie).toContain("bob.session_token=")

    const cookie = setCookie?.split(";", 1)[0]
    const settings = await handleHttp(
      request("/api/settings", { headers: cookie === undefined ? {} : { cookie } }),
      bindings
    )
    expect(settings.status).toBe(200)

    const authUser = await env.DB.prepare(
      "SELECT `id`, `email`, `email_verified` FROM `auth_user` LIMIT 1"
    ).first<{ id: string; email: string; email_verified: number }>()
    expect(authUser).toEqual({
      id: bindings.OWNER_ID,
      email: bindings.OWNER_ACCESS_EMAIL,
      email_verified: 1
    })

    const repeated = await handleHttp(
      request("/setup/api", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: "another correct horse password" })
      }),
      bindings,
      ownerAccess
    )
    expect(repeated.status).toBe(409)
  })
})
