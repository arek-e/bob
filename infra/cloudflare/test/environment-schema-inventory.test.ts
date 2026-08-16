import { describe, expect, it } from "vitest"

import {
  discoverEnvironmentSchemaDirectories,
  environmentSchemaDirectories
} from "../../../scripts/environment-schema-inventory.mjs"

describe("environment schema inventory", () => {
  it("discovers every tracked workspace schema", () => {
    expect(discoverEnvironmentSchemaDirectories()).toEqual([
      "apps/agent",
      "apps/connections-gateway",
      "apps/core-worker",
      "apps/managed-channel-router",
      "apps/sendblue-channel/egress",
      "apps/sendblue-channel/ingress",
      "apps/ui",
      "infra/cloudflare",
      "tools/data-backup",
      "tools/pi-smoke",
      "tools/sendblue-reconcile"
    ])
  })

  it("excludes root and non-workspace schemas", () => {
    expect(
      environmentSchemaDirectories([
        ".env.schema",
        "apps/worker/.env.schema",
        "apps/worker/package.json",
        "docs/example/.env.schema",
        "docs/example/package.json"
      ])
    ).toEqual(["apps/worker"])
  })
})
