import { generateKeyPair, SignJWT } from "jose"
import { describe, expect, it } from "vitest"

import {
  authorizeCoreRequest,
  verifyCloudflareAccessAssertion,
  type AccessClaims
} from "../src/modules/policy/access.ts"

const configuration = {
  ingressSecret: "i".repeat(64),
  egressSecret: "e".repeat(64),
  ownerEmail: "owner@example.invalid",
  agentSubject: "agent-service-token",
  accessIssuer: "https://team.cloudflareaccess.com",
  accessAudience: "core-audience"
}

const owner: AccessClaims = {
  subject: "owner-subject",
  email: "owner@example.invalid",
  audience: ["core-audience"]
}

const agent: AccessClaims = {
  subject: "",
  commonName: "agent-service-token",
  audience: ["core-audience"]
}

function request(path: string, token?: string): Request {
  return new Request(`https://core.example${path}`, {
    method: "POST",
    headers: token === undefined ? {} : { "x-bob-caller-token": token }
  })
}

describe("core route authorization", () => {
  it("accepts a signed Cloudflare service-token claim with an empty subject", async () => {
    const { privateKey, publicKey } = await generateKeyPair("RS256")
    const assertion = await new SignJWT({ common_name: configuration.agentSubject })
      .setProtectedHeader({ alg: "RS256", kid: "test" })
      .setIssuer(configuration.accessIssuer)
      .setAudience(configuration.accessAudience)
      .setSubject("")
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(privateKey)

    const claims = await verifyCloudflareAccessAssertion(assertion, configuration, publicKey)

    expect(claims).toMatchObject({ subject: "", commonName: configuration.agentSubject })
    await expect(
      authorizeCoreRequest(request("/internal/tools"), configuration, async () => claims)
    ).resolves.toBe("agent")
  })

  it("keeps signed owner email and non-empty subject checks", async () => {
    const { privateKey, publicKey } = await generateKeyPair("RS256")
    const assertion = await new SignJWT({ email: configuration.ownerEmail })
      .setProtectedHeader({ alg: "RS256", kid: "test" })
      .setIssuer(configuration.accessIssuer)
      .setAudience(configuration.accessAudience)
      .setSubject("owner-subject")
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(privateKey)

    const claims = await verifyCloudflareAccessAssertion(assertion, configuration, publicKey)
    await expect(
      authorizeCoreRequest(request("/api/journal"), configuration, async () => claims)
    ).resolves.toBe("owner")
  })
  it.each([
    ["/internal/inbound", "ingress", configuration.ingressSecret],
    ["/internal/inbound/event/enqueued", "ingress", configuration.ingressSecret],
    ["/internal/status", "ingress", configuration.ingressSecret],
    ["/internal/outbox/id/claim", "egress", configuration.egressSecret],
    ["/internal/outbox/id/result", "egress", configuration.egressSecret]
  ] as const)("allows only the scoped transport caller for %s", async (path, caller, secret) => {
    await expect(
      authorizeCoreRequest(request(path, secret), configuration, async () => owner)
    ).resolves.toBe(caller)
    await expect(
      authorizeCoreRequest(request(path, "wrong"), configuration, async () => owner)
    ).rejects.toThrow("access_denied")
  })

  it("allows the owner only on private UI routes", async () => {
    await expect(
      authorizeCoreRequest(request("/api/journal"), configuration, async () => owner)
    ).resolves.toBe("owner")
    await expect(
      authorizeCoreRequest(request("/api/journal"), configuration, async () => agent)
    ).rejects.toThrow("access_denied")
  })

  it("allows the agent only on tool and result routes", async () => {
    await expect(
      authorizeCoreRequest(request("/internal/tools"), configuration, async () => agent)
    ).resolves.toBe("agent")
    await expect(
      authorizeCoreRequest(request("/internal/tools"), configuration, async () => owner)
    ).rejects.toThrow("access_denied")
  })

  it("rejects an unclassified protected route", async () => {
    await expect(
      authorizeCoreRequest(request("/internal/unknown"), configuration, async () => agent)
    ).rejects.toThrow("access_denied")
  })
})
