import { describe, expect, it } from "vitest"

import type { GeneralCoreBindings } from "../src/bindings.ts"

import { composeGeneralCore } from "../src/core-composition.ts"
import { makeDeliveryTargetRegistry } from "../src/modules/delivery/target-adapter.ts"
import { makeRuntimeModules } from "../src/modules/runtime/module.ts"
import { coreRuntimeProfile } from "../src/profiles/core.ts"
import { testFixture } from "./test-fixture.ts"

const ownerId = "018e6f65-4d55-7a1b-8df4-4ee15ea1db91"

function coreBindings(): GeneralCoreBindings {
  return testFixture<GeneralCoreBindings>({
    DB: {},
    OWNER_ID: ownerId,
    OWNER_TIME_ZONE: "Europe/Stockholm",
    DATA_KEK_ACTIVE_VERSION: "1",
    DATA_KEK_KEYRING_JSON: JSON.stringify({ 1: "a".repeat(40) }),
    DATA_LOOKUP_KEY: "b".repeat(40),
    INGRESS_CALLER_SECRET: "c".repeat(32),
    EGRESS_CALLER_SECRET: "d".repeat(32),
    SENDBLUE_EGRESS_URL: "",
    BETTER_AUTH_SECRET: "e".repeat(32),
    ACCESS_TEAM_DOMAIN: "team.cloudflareaccess.com",
    CORE_ACCESS_AUDIENCE: "core",
    SETUP_ACCESS_AUDIENCE: "setup",
    OWNER_ACCESS_EMAIL: "owner@example.com",
    AGENT_CALLER_SUBJECT: "agent",
    AGENT_URL: "https://agent.example.com",
    AGENT_ACCESS_CLIENT_ID: "client",
    AGENT_ACCESS_CLIENT_SECRET: "secret",
    AGENT_ADMIN_URL: "https://agent-admin.example.com",
    AGENT_ADMIN_ACCESS_CLIENT_ID: "admin-client",
    AGENT_ADMIN_ACCESS_CLIENT_SECRET: "admin-secret",
    BOB_MODEL: "gpt-5",
    BOB_PROVIDER: "openai-codex",
    BOB_RUN_TOKEN_BUDGET: 10_000,
    BOB_DAILY_TOKEN_BUDGET: 100_000
  })
}

describe("General Core profile", () => {
  it("composes without any Vertical binding", () => {
    const composition = composeGeneralCore(coreBindings(), coreRuntimeProfile)
    expect(composition.profile.profileId).toBe("core")
    expect(composition.profile.modules.map((module) => module.id)).toEqual(["memory", "settings"])
    expect(composition.runtime.conversations).toEqual([])
    expect(composition.runtime.ownerRoutes).toEqual([])
    expect(composition.runtime.scheduledTasks).toEqual([])
    expect(composition.extensions).toEqual({})
  })

  it("rejects duplicate runtime and delivery ownership", () => {
    const route = { id: "same", handle: async () => undefined }
    expect(() => makeRuntimeModules({ ownerRoutes: [route, route] })).toThrow(
      "Duplicate owner route Module ID"
    )
    const target = { targetType: "record", statements: async () => [] }
    expect(() => makeDeliveryTargetRegistry([target, target])).toThrow(
      "Duplicate delivery target record"
    )
  })
})
