import { exportJWK, generateKeyPair, SignJWT } from "jose"
import { afterEach, describe, expect, it, vi } from "vitest"

import type { ConnectionsGatewayBindings } from "../src/bindings.ts"

import worker from "../src/index.ts"

function database(instanceId: string): D1Database {
  const statement: D1PreparedStatement = {
    bind: vi.fn(() => statement),
    first: vi.fn().mockResolvedValue({ instance_id: instanceId }),
    run: vi.fn(),
    all: vi.fn(),
    raw: vi.fn()
  }
  return {
    prepare: vi.fn(() => statement),
    batch: vi.fn(),
    exec: vi.fn(),
    withSession: vi.fn(),
    dump: vi.fn()
  }
}

async function assertion(input: {
  readonly privateKey: CryptoKey
  readonly issuer: string
  readonly audience: string
}): Promise<string> {
  return new SignJWT({ common_name: "access-client-a" })
    .setProtectedHeader({ alg: "EdDSA", kid: "gateway-test-key" })
    .setIssuer(input.issuer)
    .setAudience(input.audience)
    .setSubject("")
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(input.privateKey)
}

function gatewayRequest(token: string): Request {
  return new Request("https://connections.example/v1/connections?ownerId=owner-1", {
    headers: { "cf-access-jwt-assertion": token }
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("Connections Gateway Worker", () => {
  it("reuses dependencies only while every binding stays the same", async () => {
    const { privateKey, publicKey } = await generateKeyPair("EdDSA", { extractable: true })
    const publicJwk = {
      ...(await exportJWK(publicKey)),
      alg: "EdDSA",
      kid: "gateway-test-key",
      use: "sig"
    }
    const request = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      const url = new URL(input instanceof Request ? input.url : input.toString())
      if (url.pathname === "/cdn-cgi/access/certs") {
        return Response.json({ keys: [publicJwk] })
      }
      if (url.pathname === "/connections") return Response.json({ connections: [] })
      throw new Error(`Unexpected request: ${url.toString()}`)
    })
    vi.stubGlobal("fetch", request)

    const baseBindings: ConnectionsGatewayBindings = {
      DB: database("instance-a"),
      ACCESS_TEAM_DOMAIN: "team-a.cloudflareaccess.com",
      ACCESS_AUDIENCE: "audience-a",
      NANGO_API_URL: "https://nango-a.example",
      NANGO_SECRET_KEY: "secret-a",
      NANGO_GOOGLE_CALENDAR_INTEGRATION_ID: "google-a",
      NANGO_MICROSOFT_CALENDAR_INTEGRATION_ID: "microsoft-a"
    }
    const baseAssertion = await assertion({
      privateKey,
      issuer: "https://team-a.cloudflareaccess.com",
      audience: "audience-a"
    })

    await expect(worker.fetch(gatewayRequest(baseAssertion), baseBindings)).resolves.toMatchObject({
      status: 200
    })
    await expect(worker.fetch(gatewayRequest(baseAssertion), baseBindings)).resolves.toMatchObject({
      status: 200
    })

    const certificateRequests = () =>
      request.mock.calls.filter(([input]) => {
        const url = new URL(input instanceof Request ? input.url : input.toString())
        return url.pathname === "/cdn-cgi/access/certs"
      })
    expect(certificateRequests()).toHaveLength(1)

    const changedBindings: ReadonlyArray<ConnectionsGatewayBindings> = [
      { ...baseBindings, DB: database("instance-b") },
      { ...baseBindings, NANGO_SECRET_KEY: "secret-b" },
      { ...baseBindings, NANGO_API_URL: "https://nango-b.example" },
      { ...baseBindings, NANGO_GOOGLE_CALENDAR_INTEGRATION_ID: "google-b" },
      { ...baseBindings, NANGO_MICROSOFT_CALENDAR_INTEGRATION_ID: "microsoft-b" }
    ]
    for (const bindings of changedBindings) {
      await expect(worker.fetch(gatewayRequest(baseAssertion), bindings)).resolves.toMatchObject({
        status: 200
      })
    }
    expect(certificateRequests()).toHaveLength(6)

    const changedAudience = { ...baseBindings, ACCESS_AUDIENCE: "audience-b" }
    const audienceAssertion = await assertion({
      privateKey,
      issuer: "https://team-a.cloudflareaccess.com",
      audience: "audience-b"
    })
    await expect(
      worker.fetch(gatewayRequest(audienceAssertion), changedAudience)
    ).resolves.toMatchObject({ status: 200 })
    expect(certificateRequests()).toHaveLength(7)

    const changedTeam = { ...baseBindings, ACCESS_TEAM_DOMAIN: "team-b.cloudflareaccess.com" }
    const teamAssertion = await assertion({
      privateKey,
      issuer: "https://team-b.cloudflareaccess.com",
      audience: "audience-a"
    })
    await expect(worker.fetch(gatewayRequest(teamAssertion), changedTeam)).resolves.toMatchObject({
      status: 200
    })
    expect(certificateRequests()).toHaveLength(8)
  })
})
