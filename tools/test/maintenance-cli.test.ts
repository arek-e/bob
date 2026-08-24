import type {
  ProductionDataQuery,
  ProductionDataSummary,
  ProductionDataWorkflow
} from "@bob/operations-types/production-data"

import { describe, expect, it } from "vitest"

import type { MaintenanceRuntime } from "../maintenance/runtime.js"

import { runMaintenanceCli } from "../maintenance/cli.js"
import { migrateCommand } from "../maintenance/migrate.js"
import { inspectWorkflowCommand, summarizeActivityCommand } from "../maintenance/production-data.js"
import { readAllMessagesCommand } from "../maintenance/read-all-messages.js"
import { readLatestMessagesCommand } from "../maintenance/read-latest-messages.js"
import { showContextCommand } from "../maintenance/show-context.js"

const ownerId = "owner-1"
const localContextEnvironment = {
  BOB_MAINTENANCE_ENVIRONMENT: "development",
  BOB_MAINTENANCE_CLUSTER_ID: "local",
  BOB_MAINTENANCE_DEPLOYMENT_PROFILE_ID: "core",
  BOB_MAINTENANCE_MODE: "local"
} satisfies NodeJS.ProcessEnv
const localExecutionContext = {
  schemaVersion: "bob.maintenance-context.v1",
  environment: "development",
  clusterId: "local",
  deploymentProfileId: "core",
  mode: "local"
} as const

function createRuntime({
  onSummary,
  onWorkflow,
  onListMessages,
  onMigrate
}: {
  readonly onSummary?: (query: ProductionDataQuery) => void
  readonly onWorkflow?: (correlationId: string, limit: number) => void
  readonly onListMessages?: (owner: string, query: ProductionDataQuery) => void
  readonly onMigrate?: () => void
} = {}): MaintenanceRuntime {
  const summary: ProductionDataSummary = {
    from: "2026-08-20T00:00:00.000Z",
    to: "2026-08-21T00:00:00.000Z",
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
  }
  const workflow: ProductionDataWorkflow = {
    correlationId: "corr/1",
    inboundEvents: [],
    agentRuns: [],
    outboxMessages: [],
    deliveryAttempts: [],
    toolCalls: []
  }
  return {
    executionContext: localExecutionContext,
    productionData: {
      summary: async (query) => {
        onSummary?.(query)
        return summary
      },
      workflow: async (correlationId, limit) => {
        onWorkflow?.(correlationId, limit)
        return workflow
      }
    },
    getConversations: async () => ({
      listMessages: async (owner, query) => {
        onListMessages?.(owner, query)
        return [
          {
            id: "message-1",
            channelId: "channel-1",
            direction: "inbound",
            text: "hello",
            occurredAt: query.from,
            createdAt: query.from
          }
        ]
      }
    }),
    migrate: async () => {
      onMigrate?.()
    },
    dispose: async () => {}
  }
}

async function invoke(
  argv: readonly string[],
  {
    env = {},
    runtime = createRuntime()
  }: {
    readonly env?: NodeJS.ProcessEnv
    readonly runtime?: MaintenanceRuntime
  } = {}
) {
  return runMaintenanceCli({
    argv,
    commands: [
      showContextCommand,
      migrateCommand,
      readAllMessagesCommand,
      readLatestMessagesCommand,
      summarizeActivityCommand,
      inspectWorkflowCommand
    ],
    env: { ...localContextEnvironment, ...env },
    createRuntime: async () => runtime
  })
}

describe("Bob maintenance CLI", () => {
  it("lists registered commands without opening the database", async () => {
    let created = false
    const result = await runMaintenanceCli({
      argv: ["help"],
      commands: [migrateCommand, summarizeActivityCommand],
      env: {},
      createRuntime: async () => {
        created = true
        return createRuntime()
      }
    })

    if (result.status !== "success") throw new Error(result.error)
    expect(result.output).toContain("migrate")
    expect(result.output).toContain("summarize-activity")
    expect(result.output).not.toContain("submit")
    expect(result.output).not.toContain("status")
    expect(created).toBe(false)
  })

  it("uses a safe local context when no agent target flags are provided", async () => {
    const result = await runMaintenanceCli({
      argv: ["context"],
      commands: [showContextCommand],
      env: {},
      createRuntime: async () => createRuntime()
    })

    if (result.status !== "success") throw new Error(result.error)
    expect(JSON.parse(result.output)).toEqual({
      executionContext: {
        schemaVersion: "bob.maintenance-context.v1",
        environment: "development",
        clusterId: "local",
        deploymentProfileId: "core",
        mode: "local"
      }
    })
  })

  it("rejects commands outside the registry", async () => {
    const result = await invoke(["run-shell-command"])

    if (result.status !== "failure") throw new Error("Expected command failure")
    expect(result.error).toContain("Unknown maintenance command")
  })

  it("reports the explicit execution context without opening the database", async () => {
    const result = await invoke(["context"])

    if (result.status !== "success") throw new Error(result.error)
    expect(JSON.parse(result.output)).toEqual({ executionContext: localExecutionContext })
  })

  it("shows shared options in command help", async () => {
    const result = await invoke(["context", "--help"])

    if (result.status !== "success") throw new Error(result.error)
    expect(result.output).toContain("--context <cluster-id>")
    expect(result.output).toContain("--image <64-hex>")
  })

  it("accepts shared context and image options before or after a command", async () => {
    const imageHex = "a".repeat(64)
    const imageDigest = `sha256:${imageHex}`
    const expectedContext = {
      ...localExecutionContext,
      clusterId: "dev-eu",
      image: { name: "core", source: "pinned-image", digest: imageDigest }
    }

    const optionsAfterCommand = await invoke([
      "context",
      "--context",
      "dev-eu",
      "--image",
      imageHex
    ])
    const optionsBeforeCommand = await invoke([
      "--context",
      "dev-eu",
      "--image",
      imageHex,
      "context"
    ])

    if (optionsAfterCommand.status !== "success") throw new Error(optionsAfterCommand.error)
    if (optionsBeforeCommand.status !== "success") throw new Error(optionsBeforeCommand.error)
    expect(JSON.parse(optionsAfterCommand.output)).toEqual({ executionContext: expectedContext })
    expect(JSON.parse(optionsBeforeCommand.output)).toEqual({ executionContext: expectedContext })
  })

  it("uses context and image flags to select agent mode", async () => {
    const imageHex = "c".repeat(64)
    const result = await invoke([
      "read-latest-messages",
      "--context",
      "prod-eu",
      "--image",
      imageHex
    ])

    if (result.status !== "failure") throw new Error("Expected Control Plane configuration failure")
    expect(result.error).toContain("BOB_MAINTENANCE_CONTROL_PLANE_URL is required")
  })

  it("rejects the removed environment and profile flags", async () => {
    for (const option of ["--environment", "--deployment-profile"]) {
      const result = await invoke(["context", option, "production"])
      if (result.status !== "failure") throw new Error(`Expected ${option} to fail`)
      expect(result.error).toContain(`${option} was removed`)
    }
  })

  it("rejects a full image reference in the image option", async () => {
    const result = await invoke([
      "context",
      "--image",
      `ghcr.io/arek-e/bob-core@sha256:${"a".repeat(64)}`
    ])

    if (result.status !== "failure") throw new Error("Expected image option failure")
    expect(result.error).toContain("--image must be exactly 64 hexadecimal characters")
  })

  it("requires shared options to match a cluster-job pod context", async () => {
    const imageHex = "b".repeat(64)
    const imageDigest = `sha256:${imageHex}`
    const clusterJobEnvironment = {
      BOB_MAINTENANCE_ENVIRONMENT: "production",
      BOB_MAINTENANCE_CLUSTER_ID: "prod-eu",
      BOB_MAINTENANCE_DEPLOYMENT_PROFILE_ID: "core",
      BOB_MAINTENANCE_TARGET_REGION: "eu",
      BOB_MAINTENANCE_TARGET_PROVIDER: "aws",
      BOB_MAINTENANCE_RUNTIME_ADAPTER: "argo",
      BOB_MAINTENANCE_TARGET_REFERENCE: "eks/prod-eu",
      BOB_MAINTENANCE_TARGET_SOURCE: "terraform",
      BOB_MAINTENANCE_MODE: "cluster-job",
      BOB_MAINTENANCE_RELEASE_ID: "release-1",
      BOB_MAINTENANCE_EXECUTION_ID: "job-1",
      BOB_MAINTENANCE_IMAGE_SOURCE: "runtime-release",
      BOB_MAINTENANCE_IMAGE_DIGEST: imageDigest
    } satisfies NodeJS.ProcessEnv

    const matching = await invoke(["--context", "prod-eu", "context", "--image", imageHex], {
      env: clusterJobEnvironment
    })
    const mismatched = await invoke(["context", "--context", "prod-us"], {
      env: clusterJobEnvironment
    })

    if (matching.status !== "success") throw new Error(matching.error)
    if (mismatched.status !== "failure") throw new Error("Expected context mismatch")
    expect(JSON.parse(matching.output)).toMatchObject({
      executionContext: {
        clusterId: "prod-eu",
        mode: "cluster-job",
        image: { digest: imageDigest }
      }
    })
    expect(mismatched.error).toContain("--context must match BOB_MAINTENANCE_CLUSTER_ID")
  })

  it("runs the bounded production summary through the Operations Module", async () => {
    let requestedQuery: ProductionDataQuery | undefined
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
      { runtime: createRuntime({ onSummary: (query) => (requestedQuery = query) }) }
    )

    if (result.status !== "success") throw new Error(result.error)
    expect(JSON.parse(result.output)).toMatchObject({ totalMessages: 2 })
    expect(requestedQuery).toEqual({
      from: "2026-08-20T00:00:00.000Z",
      to: "2026-08-21T00:00:00.000Z",
      limit: 10
    })
  })

  it("passes one correlation ID to the Operations Module", async () => {
    let requestedCorrelationId = ""
    let requestedLimit = 0
    const result = await invoke(
      ["inspect-workflow", "--correlation-id", "corr/1", "--limit", "10"],
      {
        runtime: createRuntime({
          onWorkflow: (correlationId, limit) => {
            requestedCorrelationId = correlationId
            requestedLimit = limit
          }
        })
      }
    )

    if (result.status !== "success") throw new Error(result.error)
    expect(JSON.parse(result.output)).toMatchObject({ correlationId: "corr/1" })
    expect(requestedCorrelationId).toBe("corr/1")
    expect(requestedLimit).toBe(10)
  })

  it("runs the shared migration operation", async () => {
    let migrated = false
    const result = await invoke(["migrate"], {
      runtime: createRuntime({ onMigrate: () => (migrated = true) })
    })

    if (result.status !== "success") throw new Error(result.error)
    expect(JSON.parse(result.output)).toEqual({ operation: "migrate", status: "completed" })
    expect(migrated).toBe(true)
  })

  it("reads messages through ConversationStore for one approved owner", async () => {
    let requestedOwner = ""
    let requestedQuery: ProductionDataQuery | undefined
    const result = await invoke(["read-latest-messages", "--limit", "5"], {
      env: {
        BOB_OWNER_ID: ownerId,
        BOB_MAINTENANCE_CONTENT_APPROVAL: "owner-approved"
      },
      runtime: createRuntime({
        onListMessages: (owner, query) => {
          requestedOwner = owner
          requestedQuery = query
        }
      })
    })

    if (result.status !== "success") throw new Error(result.error)
    expect(JSON.parse(result.output)).toMatchObject({ messages: [{ text: "hello" }] })
    expect(requestedOwner).toBe(ownerId)
    expect(requestedQuery?.limit).toBe(5)
  })

  it("reads all bounded messages for one approved owner", async () => {
    let requestedOwner = ""
    let requestedQuery: ProductionDataQuery | undefined
    const result = await invoke(
      [
        "read-all-messages",
        "--from",
        "2026-08-20T00:00:00.000Z",
        "--to",
        "2026-08-21T00:00:00.000Z",
        "--limit",
        "1000"
      ],
      {
        env: {
          BOB_OWNER_ID: ownerId,
          BOB_MAINTENANCE_CONTENT_APPROVAL: "owner-approved"
        },
        runtime: createRuntime({
          onListMessages: (owner, query) => {
            requestedOwner = owner
            requestedQuery = query
          }
        })
      }
    )

    if (result.status !== "success") throw new Error(result.error)
    expect(JSON.parse(result.output)).toMatchObject({
      messageCount: 1,
      possiblyMore: false,
      messages: [{ text: "hello" }]
    })
    expect(requestedOwner).toBe(ownerId)
    expect(requestedQuery).toEqual({
      from: "2026-08-20T00:00:00.000Z",
      to: "2026-08-21T00:00:00.000Z",
      limit: 1000
    })
  })

  it("requires an explicit window for all-message reads", async () => {
    const result = await invoke(["read-all-messages"], {
      env: {
        BOB_OWNER_ID: ownerId,
        BOB_MAINTENANCE_CONTENT_APPROVAL: "owner-approved"
      }
    })

    if (result.status !== "failure") throw new Error("Expected all-message query failure")
    expect(result.error).toContain("Option --from is required")
  })

  it("does not read message content without explicit approval", async () => {
    const result = await invoke(["read-latest-messages"], {
      env: { BOB_OWNER_ID: ownerId }
    })

    if (result.status !== "failure") throw new Error("Expected content approval failure")
    expect(result.error).toContain("BOB_MAINTENANCE_CONTENT_APPROVAL=owner-approved")
  })
})
