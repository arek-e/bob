import type { ConnectionStore } from "@bob/connections-service/store"
import type {
  ToolCommandAdapter,
  ToolCommandAdapterContext,
  ToolRunContext
} from "@bob/core-service/conversations/tool-adapter"
import type { MemoryStore } from "@bob/core-service/memory/store"
import type { RetrievalPipeline } from "@bob/core-service/retrieval/pipeline"
import type { OwnerSettingsStore } from "@bob/core-service/settings/store"
import type { AgentRunRequest } from "@bob/core-types/agent"
import type { JournalStore } from "@bob/journal-service/store"
import type { ReminderStore } from "@bob/reminders-service/store"
import type { TrainingModule } from "@bob/training-service/module"

import { makeConnectionsToolAdapter } from "@bob/connections-service/tool-adapter"
import {
  capabilityToolNames,
  type CapabilityModule,
  type ToolCommand,
  type ToolName
} from "@bob/core-capabilities-types/tools"
import { makeToolAdapterRegistry } from "@bob/core-service/conversations/tool-adapter"
import { expiredToolCallOutcome } from "@bob/core-service/conversations/tool-executor"
import { makeMemoryToolAdapter } from "@bob/core-service/memory/tool-adapter"
import { makeSettingsToolAdapter } from "@bob/core-service/settings/tool-adapter"
import { coreDeploymentProfile, transitionalDeploymentProfile } from "@bob/core-types/profiles"
import { makeJournalToolAdapter } from "@bob/journal-service/tool-adapter"
import { makeReminderToolAdapter } from "@bob/reminders-service/tool-adapter"
import { makeTrainingToolAdapter } from "@bob/training-service/tool-adapter"
import { Schema } from "effect"
import { describe, expect, it, vi } from "vitest"

import { testFixture } from "./test-fixture.ts"

const ownerId = "00000000-0000-4000-8000-000000000001"
const runId = "00000000-0000-4000-8000-000000000002"

function run(userText: string): ToolRunContext {
  return {
    // SAFETY: This controlled test fixture matches the asserted contract used by this test.
    request: {
      runId,
      ownerId,
      userText,
      sourceMessageId: "00000000-0000-4000-8000-000000000003",
      timeZone: "Europe/Stockholm",
      localTime: "2026-08-11T10:00:00.000Z",
      allowedTools: [],
      protocolVersion: 1,
      correlationId: "00000000-0000-4000-8000-000000000004",
      conversationTurnId: "00000000-0000-4000-8000-000000000005",
      conversationTurnRevision: 1,
      contextItems: [],
      limits: {
        maxTurns: 4,
        maxToolCalls: 4,
        maxDurationMs: 60_000,
        maxResponseCharacters: 1_200
      }
    } as AgentRunRequest,
    channelId: "channel",
    messageId: "00000000-0000-4000-8000-000000000003"
  }
}

function commandContext(
  name: ToolName,
  argumentsValue: typeof Schema.Json.Type,
  userText = "Show my saved records."
): ToolCommandAdapterContext {
  return {
    // SAFETY: This controlled test fixture matches the asserted contract used by this test.
    command: {
      runId,
      toolCallId: "tool-call",
      idempotencyKey: "tool-call-key",
      ownerId,
      name,
      arguments: argumentsValue
    } as ToolCommand,
    run: run(userText)
  }
}

describe("domain-owned Tool command Adapters", () => {
  function adapterFor(module: CapabilityModule): ToolCommandAdapter {
    return {
      capabilityId: module.id,
      names: capabilityToolNames(module),
      execute: vi.fn().mockResolvedValue({ ok: true, code: "ok", message: "Done." })
    }
  }

  it("composes a core registry without a Training Adapter", () => {
    const registry = makeToolAdapterRegistry(
      coreDeploymentProfile,
      coreDeploymentProfile.modules.map(adapterFor)
    )

    expect(registry.adapterFor("memory_search")?.capabilityId).toBe("memory")
    expect(registry.adapterFor("workout_start")).toBeUndefined()
  })

  it("rejects missing and unselected Adapters", () => {
    expect(() => makeToolAdapterRegistry(coreDeploymentProfile, [])).toThrow("Missing Tool Adapter")
    const training = transitionalDeploymentProfile.modules.find(
      (module) => module.id === "training"
    )
    expect(training).toBeDefined()
    expect(() => makeToolAdapterRegistry(coreDeploymentProfile, [adapterFor(training!)])).toThrow(
      "is not in profile core"
    )
  })

  it("stops replay after an expired external mutation lease", () => {
    expect(
      expiredToolCallOutcome("connection_link_create", transitionalDeploymentProfile)
    ).toMatchObject({
      ok: false,
      code: "external_outcome_unknown"
    })
    expect(expiredToolCallOutcome("reminder_create", transitionalDeploymentProfile)).toBeUndefined()
  })

  it("keeps reminder list behavior in the Reminder Adapter", async () => {
    // SAFETY: This controlled test fixture matches the asserted contract used by this test.
    const reminders = testFixture<ReminderStore>({ list: vi.fn().mockResolvedValue([]) })
    const result = await makeReminderToolAdapter(reminders).execute(
      commandContext("reminder_list", {})
    )

    expect(result).toMatchObject({ ok: true, code: "reminder_list", data: { reminders: [] } })
    expect(reminders.list).toHaveBeenCalledWith(ownerId)
  })

  it("keeps training proposal behavior in the Training Adapter", async () => {
    const proposeTraining = vi.fn().mockResolvedValue({
      id: "proposal",
      proposalHash: "sha256:proposal",
      status: "proposed"
    })
    // SAFETY: This controlled test fixture matches the asserted contract used by this test.
    const training = testFixture<TrainingModule>({ proposeTraining })
    const result = await makeTrainingToolAdapter(training).execute(
      commandContext("gym_create", { name: "Home gym" }, "Please create a gym called Home gym.")
    )

    expect(result).toMatchObject({
      ok: true,
      code: "training_proposed",
      data: { proposalId: "proposal", proposalHash: "sha256:proposal" }
    })
    expect(proposeTraining).toHaveBeenCalledWith(
      expect.objectContaining({ ownerId, toolName: "gym_create" })
    )
  })

  it("keeps journal link composition in the Journal Adapter", async () => {
    // SAFETY: This controlled test fixture matches the asserted contract used by this test.
    const journal = testFixture<JournalStore>({
      createHandoff: vi.fn().mockResolvedValue({
        id: "handoff",
        expiresAt: "2026-08-11T10:10:00.000Z"
      })
    })
    const excludeFromContext = vi.fn().mockResolvedValue(true)
    const result = await makeJournalToolAdapter(
      journal,
      { excludeFromContext },
      { uiBaseUrl: "https://bob.example.invalid" }
    ).execute(commandContext("journal_link_create", {}))

    expect(result).toMatchObject({
      ok: true,
      code: "journal_link_created",
      data: { path: "https://bob.example.invalid/journal/handoff", bearerToken: false }
    })
    expect(excludeFromContext).toHaveBeenCalledWith("00000000-0000-4000-8000-000000000005", 1)
  })

  it("fails a private Tool before execution when turn exclusion fails", async () => {
    const createHandoff = vi.fn()
    const journal = testFixture<JournalStore>({ createHandoff })
    const result = await makeJournalToolAdapter(
      journal,
      { excludeFromContext: vi.fn().mockResolvedValue(false) },
      { uiBaseUrl: "https://bob.example.invalid" }
    ).execute(commandContext("journal_link_create", {}))

    expect(result).toMatchObject({ ok: false, code: "privacy_policy_failed" })
    expect(createHandoff).not.toHaveBeenCalled()
  })

  it("keeps recall behavior in the Memory Adapter", async () => {
    const memory = testFixture<MemoryStore>({})
    const retrieve = vi.fn().mockResolvedValue({
      status: "abstain",
      reason: "no_candidates",
      items: [],
      candidateCount: 0,
      relevantCount: 0,
      temporal: { mode: "current", at: "2026-08-11T10:00:00.000Z" }
    })
    const retrieval = testFixture<RetrievalPipeline>({ retrieve })
    const result = await makeMemoryToolAdapter(memory, retrieval).execute(
      commandContext("memory_search", { query: "gym" })
    )

    expect(result).toMatchObject({ ok: true, code: "memory_results", data: { matches: [] } })
    expect(retrieve).toHaveBeenCalledWith(
      expect.objectContaining({ ownerId, query: "gym", channel: true })
    )
  })

  it("keeps the Memory Tool result flat across retrieval units", async () => {
    const memory = testFixture<MemoryStore>({})
    const item = (id: string, text: string) => ({
      id,
      sourceId: `source-${id}`,
      sourceType: "fact_revision",
      memoryClass: "owner_fact" as const,
      text,
      sourceLabel: `Source ${id}`
    })
    const retrieval = testFixture<RetrievalPipeline>({
      retrieve: vi.fn().mockResolvedValue({
        status: "supported",
        candidateCount: 3,
        relevantCount: 3,
        temporal: { mode: "current", at: "2026-08-11T10:00:00.000Z" },
        items: [
          { kind: "candidate", item: item("single", "One value") },
          {
            kind: "conflict_group",
            conflictKey: "desk",
            items: [item("upstairs", "Desk is upstairs"), item("downstairs", "Desk is downstairs")]
          }
        ]
      })
    })

    const result = await makeMemoryToolAdapter(memory, retrieval).execute(
      commandContext("memory_search", { query: "desk" })
    )

    expect(result).toMatchObject({
      ok: true,
      data: {
        matches: [
          { id: "single", conflict: false },
          { id: "upstairs", conflict: true, conflictKey: "desk" },
          { id: "downstairs", conflict: true, conflictKey: "desk" }
        ]
      }
    })
  })

  it("keeps owner settings and connection commands in their Adapters", async () => {
    // SAFETY: This controlled test fixture matches the asserted contract used by this test.
    const settings = testFixture<OwnerSettingsStore>({
      get: vi.fn().mockResolvedValue({
        timeZone: "Europe/Stockholm",
        locale: "en",
        hourCycle: "auto",
        updatedAt: "2026-08-11T10:00:00.000Z"
      }),
      connections: vi.fn().mockResolvedValue([])
    })
    // SAFETY: This controlled test fixture matches the asserted contract used by this test.
    const connections = testFixture<ConnectionStore>({
      list: vi.fn().mockResolvedValue([]),
      createSession: vi.fn().mockResolvedValue({
        provider: "google_calendar",
        connectUrl: "https://connect.example.invalid",
        expiresAt: "2026-08-11T10:30:00.000Z"
      })
    })

    const settingsResult = await makeSettingsToolAdapter(settings).execute(
      commandContext("settings_get", {})
    )
    const connectionResult = await makeConnectionsToolAdapter(connections).execute(
      commandContext("connection_list", {})
    )

    expect(settingsResult).toMatchObject({ ok: true, code: "owner_settings" })
    expect(connectionResult).toMatchObject({ ok: true, code: "connection_list" })
  })
})
