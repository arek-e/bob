import { Schema } from "effect"
import { describe, expect, it } from "vitest"

import type { ToolDefinition } from "../src/capabilities/definitions.ts"

import {
  CapabilityCatalogueGeneration,
  makeCapabilityCatalogue
} from "../src/capabilities/catalogue.ts"
import { memoryCapability } from "../src/capabilities/memory.ts"
import { coreDeploymentProfile, transitionalDeploymentProfile } from "../src/deployment-profiles.ts"

describe("Bob tool catalogue", () => {
  it("publishes one valid generation for the reviewed catalogue", () => {
    expect(transitionalDeploymentProfile.generation).toMatch(/^capability-v2:[0-9a-f]{16}$/u)
    expect(
      Schema.decodeUnknownSync(CapabilityCatalogueGeneration)(
        transitionalDeploymentProfile.generation
      )
    ).toBe(transitionalDeploymentProfile.generation)
  })

  it("assigns every Tool to one reviewed capability Module", () => {
    const names = transitionalDeploymentProfile.modules.flatMap((capability) => capability.names)

    expect(names.toSorted()).toEqual([...transitionalDeploymentProfile.names].toSorted())
    expect(new Set(names).size).toBe(names.length)
    expect(transitionalDeploymentProfile.modules.map((capability) => capability.id)).toEqual([
      "reminders",
      "memory",
      "journal",
      "training",
      "settings",
      "connections"
    ])
    expect(transitionalDeploymentProfile.moduleFor("workout_start")).toMatchObject({
      id: "training",
      feature: "training",
      version: 1
    })
  })

  it("builds a core profile without optional vertical Modules", () => {
    expect(coreDeploymentProfile.modules.map((module) => module.id)).toEqual(["memory", "settings"])
    expect(coreDeploymentProfile.names).toContain("memory_search")
    expect(coreDeploymentProfile.names).not.toContain("workout_start")
    expect(coreDeploymentProfile.generation).not.toBe(transitionalDeploymentProfile.generation)
  })

  it("rejects duplicate Capability Modules in one profile", () => {
    expect(() => makeCapabilityCatalogue("core", [memoryCapability, memoryCapability])).toThrow(
      "Duplicate Capability Module ID"
    )
  })

  it("keeps Tool safety policy with its owning capability", () => {
    expect(transitionalDeploymentProfile.isReadOnly("memory_search")).toBe(true)
    expect(transitionalDeploymentProfile.isReadOnly("memory_propose")).toBe(false)
    expect(transitionalDeploymentProfile.isSourceBound("memory_propose")).toBe(true)
    expect(transitionalDeploymentProfile.isSourceBound("reminder_create")).toBe(true)
    expect(transitionalDeploymentProfile.hasUnknownExternalOutcome("connection_link_create")).toBe(
      true
    )
    expect(transitionalDeploymentProfile.hasUnknownExternalOutcome("settings_update")).toBe(false)
  })

  it("covers every registered Tool definition except deterministic commands", () => {
    const names = transitionalDeploymentProfile.modelToolNames.toSorted()
    const expected = [...transitionalDeploymentProfile.modelToolNames].toSorted()

    expect(names).toEqual(expected)
    expect(transitionalDeploymentProfile.definitionFor("memory_correct")).toBeUndefined()
  })

  it("exposes every reviewed model capability without an owner-text router", () => {
    expect(transitionalDeploymentProfile.modelToolNames).not.toContain("memory_confirm")
    expect(transitionalDeploymentProfile.modelToolNames).not.toContain("memory_correct")
  })

  it("keeps each definition provider-neutral and explicit", () => {
    for (const name of transitionalDeploymentProfile.modelToolNames) {
      const definition: ToolDefinition | undefined =
        transitionalDeploymentProfile.definitionFor(name)
      expect(definition).toBeDefined()
      if (definition === undefined) throw new Error(`Missing definition for ${name}`)
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
    expect(
      transitionalDeploymentProfile.definitionFor("reminder_create")?.inputSchema.properties
        .displayText
    ).toMatchObject({
      type: "string",
      maxLength: 1_200
    })
    expect(
      transitionalDeploymentProfile.definitionFor("gym_list")?.inputSchema.properties.query
    ).toMatchObject({
      type: "string",
      maxLength: 100
    })
    expect(
      transitionalDeploymentProfile.definitionFor("connection_link_create")?.inputSchema.properties
        .provider
    ).toMatchObject({
      type: "string",
      enum: ["google_calendar", "microsoft_calendar"]
    })
  })
})
