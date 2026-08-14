import { describe, expect, it } from "vitest"

import {
  modelToolNames,
  ToolName,
  toolDefinitionForName,
  toolDefinitions,
  type ToolDefinitionName
} from "../src/tools.ts"

describe("Bob tool catalogue", () => {
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
