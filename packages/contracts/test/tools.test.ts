import { Schema } from "effect"
import { describe, expect, it } from "vitest"

import {
  capabilityCatalogueGeneration,
  capabilityForToolName,
  capabilityModules,
  CapabilityCatalogueGeneration,
  hasUnknownExternalOutcome,
  isReadOnlyToolName,
  isSourceBoundToolName,
  modelToolNames,
  ToolName,
  toolDefinitionForName,
  toolDefinitions,
  type ToolDefinitionName
} from "../src/tools.ts"

describe("Bob tool catalogue", () => {
  it("publishes one valid generation for the reviewed catalogue", () => {
    expect(capabilityCatalogueGeneration).toMatch(/^capability-v1:[0-9a-f]{16}$/u)
    expect(
      Schema.decodeUnknownSync(CapabilityCatalogueGeneration)(capabilityCatalogueGeneration)
    ).toBe(capabilityCatalogueGeneration)
  })

  it("assigns every Tool to one reviewed capability Module", () => {
    const names = capabilityModules.flatMap((capability) => capability.names)

    expect(names.toSorted()).toEqual([...ToolName.literals].toSorted())
    expect(new Set(names).size).toBe(names.length)
    expect(capabilityModules.map((capability) => capability.id)).toEqual([
      "reminders",
      "memory",
      "journal",
      "training",
      "settings",
      "connections"
    ])
    expect(capabilityForToolName("workout_start")).toMatchObject({
      id: "training",
      feature: "training",
      version: 1
    })
  })

  it("keeps Tool safety policy with its owning capability", () => {
    expect(isReadOnlyToolName("memory_search")).toBe(true)
    expect(isReadOnlyToolName("memory_propose")).toBe(false)
    expect(isSourceBoundToolName("memory_propose")).toBe(true)
    expect(isSourceBoundToolName("reminder_create")).toBe(true)
    expect(hasUnknownExternalOutcome("connection_link_create")).toBe(true)
    expect(hasUnknownExternalOutcome("settings_update")).toBe(false)
  })

  it("covers every registered Tool definition except deterministic commands", () => {
    const names = Object.keys(toolDefinitions).toSorted()
    const expected = ToolName.literals.filter((name) => name !== "memory_correct").toSorted()

    expect(names).toEqual(expected)
    expect(toolDefinitionForName("memory_correct")).toBeUndefined()
  })

  it("exposes every reviewed model capability without an owner-text router", () => {
    expect(modelToolNames.toSorted()).toEqual(
      Object.keys(toolDefinitions)
        .filter((name) => name !== "memory_confirm")
        .toSorted()
    )
    expect(modelToolNames).not.toContain("memory_confirm")
    expect(modelToolNames).not.toContain("memory_correct")
  })

  it("keeps each definition provider-neutral and explicit", () => {
    // SAFETY: This controlled test fixture matches the asserted contract used by this test.
    for (const [name, definition] of Object.entries(toolDefinitions) as [
      ToolDefinitionName,
      (typeof toolDefinitions)[ToolDefinitionName]
    ][]) {
      expect(definition.name).toBe(name)
      expect(definition.description.length).toBeGreaterThan(0)
      expect(definition.inputSchema).toMatchObject({
        type: "object",
        additionalProperties: false
      })
      expect(definition.inputSchema).not.toHaveProperty("provider")
    }
  })

  it("keeps reviewed constraints in the canonical input schema", () => {
    expect(toolDefinitions.reminder_create.inputSchema.properties.displayText).toMatchObject({
      type: "string",
      maxLength: 1_200
    })
    expect(toolDefinitions.gym_list.inputSchema.properties.query).toMatchObject({
      type: "string",
      maxLength: 100
    })
    expect(toolDefinitions.connection_link_create.inputSchema.properties.provider).toMatchObject({
      type: "string",
      enum: ["google_calendar", "microsoft_calendar"]
    })
  })
})
