import type { AgentRunRequest } from "@bob/contracts/agent"
import type { CapabilityModule, ToolCommand, ToolName } from "@bob/contracts/tools"

import { coreCapabilityCatalogue, fullCapabilityCatalogue } from "@bob/contracts/tools"
import { Schema } from "effect"
import { describe, expect, it, vi } from "vitest"

import type { ConnectionStore } from "../src/modules/connections/store.ts"
import type {
  ToolCommandAdapter,
  ToolCommandAdapterContext,
  ToolRunContext
} from "../src/modules/conversations/tool-adapter.ts"
import type { JournalStore } from "../src/modules/journal/store.ts"
import type { MemoryStore } from "../src/modules/memory/store.ts"
import type { ReminderStore } from "../src/modules/reminders/store.ts"
import type { OwnerSettingsStore } from "../src/modules/settings/store.ts"
import type { TrainingModule } from "../src/modules/training/module.ts"

import { makeConnectionsToolAdapter } from "../src/modules/connections/tool-adapter.ts"
import { makeToolAdapterRegistry } from "../src/modules/conversations/tool-adapter.ts"
import { expiredToolCallOutcome } from "../src/modules/conversations/tool-executor.ts"
import { makeJournalToolAdapter } from "../src/modules/journal/tool-adapter.ts"
import { makeMemoryToolAdapter } from "../src/modules/memory/tool-adapter.ts"
import { makeReminderToolAdapter } from "../src/modules/reminders/tool-adapter.ts"
import { makeSettingsToolAdapter } from "../src/modules/settings/tool-adapter.ts"
import { makeTrainingToolAdapter } from "../src/modules/training/tool-adapter.ts"
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
      names: module.names,
      execute: vi.fn().mockResolvedValue({ ok: true, code: "ok", message: "Done." })
    }
  }

  it("composes a core registry without a Training Adapter", () => {
    const registry = makeToolAdapterRegistry(
      coreCapabilityCatalogue,
      coreCapabilityCatalogue.modules.map(adapterFor)
    )

    expect(registry.adapterFor("memory_search")?.capabilityId).toBe("memory")
    expect(registry.adapterFor("workout_start")).toBeUndefined()
  })

  it("rejects missing and unselected Adapters", () => {
    expect(() => makeToolAdapterRegistry(coreCapabilityCatalogue, [])).toThrow(
      "Missing Tool Adapter"
    )
    const training = fullCapabilityCatalogue.modules.find((module) => module.id === "training")
    expect(training).toBeDefined()
    expect(() => makeToolAdapterRegistry(coreCapabilityCatalogue, [adapterFor(training!)])).toThrow(
      "is not in profile core"
    )
  })

  it("stops replay after an expired external mutation lease", () => {
    expect(expiredToolCallOutcome("connection_link_create")).toMatchObject({
      ok: false,
      code: "external_outcome_unknown"
    })
    expect(expiredToolCallOutcome("reminder_create")).toBeUndefined()
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
    const result = await makeJournalToolAdapter(journal, {
      uiBaseUrl: "https://bob.example.invalid"
    }).execute(commandContext("journal_link_create", {}))

    expect(result).toMatchObject({
      ok: true,
      code: "journal_link_created",
      data: { path: "https://bob.example.invalid/journal/handoff", bearerToken: false }
    })
  })

  it("keeps recall behavior in the Memory Adapter", async () => {
    // SAFETY: This controlled test fixture matches the asserted contract used by this test.
    const memory = testFixture<MemoryStore>({
      search: vi.fn().mockResolvedValue([])
    })
    const result = await makeMemoryToolAdapter(memory).execute(
      commandContext("memory_search", { query: "gym" })
    )

    expect(result).toMatchObject({ ok: true, code: "memory_results", data: { matches: [] } })
    expect(memory.search).toHaveBeenCalledWith(ownerId, "gym", true)
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
