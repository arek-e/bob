import { render } from "ink-testing-library"
import React from "react"
import { describe, expect, it } from "vitest"

import type { MaintenanceRuntime } from "../maintenance/runtime.js"

import { MaintenanceApp } from "../maintenance/app.js"
import { summarizeActivityCommand } from "../maintenance/production-data.js"

const contextEnvironment = {
  BOB_MAINTENANCE_ENVIRONMENT: "development",
  BOB_MAINTENANCE_CLUSTER_ID: "local",
  BOB_MAINTENANCE_DEPLOYMENT_PROFILE_ID: "core",
  BOB_MAINTENANCE_MODE: "local"
} satisfies NodeJS.ProcessEnv

type InkTestInstance = {
  readonly lastFrame: () => string | undefined
  readonly unmount: () => void
}

function testRuntime(): MaintenanceRuntime {
  return {
    executionContext: {
      schemaVersion: "bob.maintenance-context.v1",
      environment: "development",
      clusterId: "local",
      deploymentProfileId: "core",
      mode: "local"
    },
    productionData: {
      summary: async (query) => ({
        from: query.from,
        to: query.to,
        totalMessages: 2,
        totalOwners: 1,
        totalAgentRuns: 1,
        totalToolCalls: 0,
        messageDirections: [],
        inboundEventStates: [],
        agentRunStates: [],
        deliveryStates: [],
        toolCallStates: [],
        owners: []
      }),
      workflow: async (correlationId) => ({
        correlationId,
        inboundEvents: [],
        agentRuns: [],
        outboxMessages: [],
        deliveryAttempts: [],
        toolCalls: []
      })
    },
    getConversations: async () => ({ listMessages: async () => [] }),
    migrate: async () => {},
    dispose: async () => {}
  }
}

async function waitForOutput(
  app: InkTestInstance,
  predicate: (frame: string) => boolean
): Promise<string> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const frame = app.lastFrame()
    if (frame !== undefined && predicate(frame)) return frame
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error("Timed out waiting for Ink output")
}

describe("MaintenanceApp", () => {
  it("renders command output and completes with success", async () => {
    let exitCode: 0 | 1 | undefined
    const app = render(
      <MaintenanceApp
        argv={["summarize-activity"]}
        commands={[summarizeActivityCommand]}
        env={contextEnvironment}
        createRuntime={async () => testRuntime()}
        onComplete={(code) => {
          exitCode = code
        }}
      />
    )

    const frame = await waitForOutput(app, (value) => value.includes('"totalMessages": 2'))

    expect(frame).toContain('"totalMessages": 2')
    expect(exitCode).toBe(0)
    app.unmount()
  })

  it("renders command errors with a non-zero completion code", async () => {
    let exitCode: 0 | 1 | undefined
    const app = render(
      <MaintenanceApp
        argv={["summarize-activity"]}
        commands={[summarizeActivityCommand]}
        env={contextEnvironment}
        createRuntime={async () => {
          throw new Error("database unavailable")
        }}
        onComplete={(code) => {
          exitCode = code
        }}
      />
    )

    const frame = await waitForOutput(app, (value) => value.includes("Maintenance command failed"))

    expect(frame).toContain("Maintenance command failed")
    expect(exitCode).toBe(1)
    app.unmount()
  })
})
