import { describe, expect, it } from "vitest"

import { authorizeCoreRequest, authorizeSetupRequest } from "../src/modules/policy/access.ts"

const configuration = {
  ingressSecret: "i".repeat(64),
  egressSecret: "e".repeat(64),
  agentSecret: "a".repeat(64)
}

function request(path: string, token?: string, header = "x-bob-caller-token"): Request {
  return new Request(`https://core.example${path}`, {
    method: "POST",
    headers: token === undefined ? {} : { [header]: token }
  })
}

describe("core route authorization", () => {
  it.each([
    ["/internal/inbound", "ingress", configuration.ingressSecret],
    ["/internal/inbound/event/enqueued", "ingress", configuration.ingressSecret],
    ["/internal/status", "ingress", configuration.ingressSecret],
    ["/internal/outbox/id/claim", "egress", configuration.egressSecret],
    ["/internal/outbox/id/result", "egress", configuration.egressSecret],
    ["/internal/tools", "agent", configuration.agentSecret],
    ["/internal/agent/result", "agent", configuration.agentSecret],
    ["/internal/agent/operations", "agent", configuration.agentSecret],
    ["/internal/agent/operations/load", "agent", configuration.agentSecret],
    ["/internal/readiness", "agent", configuration.agentSecret]
  ] as const)("allows only the scoped caller for %s", async (path, caller, secret) => {
    await expect(authorizeCoreRequest(request(path, secret), configuration)).resolves.toBe(caller)
    await expect(authorizeCoreRequest(request(path, "wrong"), configuration)).rejects.toThrow(
      "access_denied"
    )
  })

  it("accepts the setup token only on the setup route", async () => {
    const setupToken = "s".repeat(64)
    await expect(
      authorizeSetupRequest(request("/setup/api", setupToken, "x-bob-setup-token"), { setupToken })
    ).resolves.toBeUndefined()
    await expect(
      authorizeSetupRequest(request("/setup/api", "wrong", "x-bob-setup-token"), { setupToken })
    ).rejects.toThrow("access_denied")
  })

  it("rejects an unclassified protected route", async () => {
    await expect(
      authorizeCoreRequest(request("/internal/unknown", configuration.agentSecret), configuration)
    ).rejects.toThrow("access_denied")
  })
})
