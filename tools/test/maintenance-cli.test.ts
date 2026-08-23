import { describe, expect, it } from "vitest"

import { runMaintenanceCli } from "../maintenance/cli.js"
import { inspectWorkflowCommand, summarizeActivityCommand } from "../maintenance/production-data.js"
import { readLatestMessagesCommand } from "../maintenance/read-latest-messages.js"

const token = "t".repeat(32)

async function invoke(
  argv: readonly string[],
  {
    env = {},
    fetchImplementation = async () => new Response("{}")
  }: {
    readonly env?: NodeJS.ProcessEnv
    readonly fetchImplementation?: typeof fetch
  } = {}
) {
  return runMaintenanceCli({
    argv,
    commands: [readLatestMessagesCommand, summarizeActivityCommand, inspectWorkflowCommand],
    env: {
      BOB_PRODUCTION_CORE_URL: "https://core.example",
      PRODUCTION_DATA_INSPECTOR_TOKEN: token,
      ...env
    },
    fetchImplementation
  })
}

describe("Bob maintenance CLI", () => {
  it("lists registered commands", async () => {
    const result = await invoke(["help"])

    if (result.status !== "success") throw new Error(result.error)
    expect(result.output).toContain("read-latest-messages")
    expect(result.output).toContain("summarize-activity")
    expect(result.output).toContain("inspect-workflow")
  })

  it("rejects commands outside the registry", async () => {
    const result = await invoke(["run-shell-command"])

    if (result.status !== "failure") throw new Error("Expected command failure")
    expect(result.error).toContain("Unknown maintenance command")
  })

  it("runs the bounded production summary command", async () => {
    let requestedUrl = ""
    let requestedToken = ""
    const result = await invoke(
      [
        "summarize-activity",
        "--from",
        "2026-08-20T00:00:00.000Z",
        "--to",
        "2026-08-21T00:00:00.000Z",
        "--limit",
        "10"
      ],
      {
        fetchImplementation: async (input, init) => {
          requestedUrl = String(input)
          requestedToken = String(new Headers(init?.headers).get("x-bob-caller-token"))
          return new Response(JSON.stringify({ messageCount: 2 }))
        }
      }
    )

    if (result.status !== "success") throw new Error(result.error)
    expect(JSON.parse(result.output)).toEqual({ messageCount: 2 })
    expect(new URL(requestedUrl).pathname).toBe("/internal/production-data/summary")
    expect(new URL(requestedUrl).searchParams.get("limit")).toBe("10")
    expect(requestedToken).toBe(token)
  })

  it("encodes the workflow correlation ID and uses the configured token variable", async () => {
    let requestedUrl = ""
    let requestedToken = ""
    const result = await invoke(
      ["inspect-workflow", "--correlation-id", "corr/1", "--token-env", "BOB_INSPECTOR_TOKEN"],
      {
        env: { BOB_INSPECTOR_TOKEN: "c".repeat(32) },
        fetchImplementation: async (input, init) => {
          requestedUrl = String(input)
          requestedToken = String(new Headers(init?.headers).get("x-bob-caller-token"))
          return new Response(JSON.stringify({ correlationId: "corr/1" }))
        }
      }
    )

    if (result.status !== "success") throw new Error(result.error)
    expect(requestedUrl).toContain("/internal/production-data/workflow/corr%2F1")
    expect(requestedToken).toBe("c".repeat(32))
  })

  it("does not expose missing token values in errors", async () => {
    const result = await invoke(["summarize-activity"], {
      env: { PRODUCTION_DATA_INSPECTOR_TOKEN: "short" }
    })

    if (result.status !== "failure") throw new Error("Expected token failure")
    expect(result.error).toBe("Inspector token is missing or invalid")
    expect(result.error).not.toContain("short")
  })

  it("explains rejected inspector authentication without exposing the token", async () => {
    const result = await invoke(["summarize-activity"], {
      fetchImplementation: async () => new Response("{}", { status: 401 })
    })

    if (result.status !== "failure") throw new Error("Expected authentication failure")
    expect(result.error).toBe(
      "Inspector authentication failed (HTTP 401); verify the configured inspector token and Core secret projection"
    )
    expect(result.error).not.toContain(token)
  })

  it("reads latest messages through an owner session cookie", async () => {
    let requestedUrl = ""
    let requestedCookie = ""
    const result = await invoke(
      ["read-latest-messages", "--limit", "5", "--session-cookie-env", "BOB_OWNER_COOKIE"],
      {
        env: { BOB_OWNER_COOKIE: "better-auth.session=fixture" },
        fetchImplementation: async (input, init) => {
          requestedUrl = String(input)
          requestedCookie = String(new Headers(init?.headers).get("cookie"))
          return new Response(JSON.stringify({ messages: [{ text: "hello" }] }))
        }
      }
    )

    if (result.status !== "success") throw new Error(result.error)
    expect(JSON.parse(result.output)).toEqual({ messages: [{ text: "hello" }] })
    expect(new URL(requestedUrl).pathname).toBe("/api/production-data/messages")
    expect(new URL(requestedUrl).searchParams.get("limit")).toBe("5")
    expect(requestedCookie).toBe("better-auth.session=fixture")
  })
})
