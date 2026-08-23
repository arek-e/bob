import { render } from "ink-testing-library"
import React from "react"
import { describe, expect, it } from "vitest"

import { MaintenanceApp } from "../maintenance/app.js"
import { summarizeActivityCommand } from "../maintenance/production-data.js"

type InkTestInstance = {
  readonly lastFrame: () => string | undefined
  readonly unmount: () => void
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
        env={{
          BOB_PRODUCTION_CORE_URL: "https://core.example",
          PRODUCTION_DATA_INSPECTOR_TOKEN: "t".repeat(32)
        }}
        fetchImplementation={async () => new Response(JSON.stringify({ messageCount: 2 }))}
        onComplete={(code) => {
          exitCode = code
        }}
      />
    )

    const frame = await waitForOutput(app, (value) => value.includes('"messageCount": 2'))

    expect(frame).toContain('"messageCount": 2')
    expect(exitCode).toBe(0)
    app.unmount()
  })

  it("renders command errors with a non-zero completion code", async () => {
    let exitCode: 0 | 1 | undefined
    const app = render(
      <MaintenanceApp
        argv={["summarize-activity"]}
        commands={[summarizeActivityCommand]}
        env={{ BOB_PRODUCTION_CORE_URL: "https://core.example" }}
        fetchImplementation={async () => new Response("{}")}
        onComplete={(code) => {
          exitCode = code
        }}
      />
    )

    const frame = await waitForOutput(app, (value) => value.includes("Inspector token is missing"))

    expect(frame).toContain("Inspector token is missing or invalid")
    expect(exitCode).toBe(1)
    app.unmount()
  })
})
