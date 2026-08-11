import type { AgentTool } from "@earendil-works/pi-agent-core"
import { Type } from "@earendil-works/pi-ai"
import type { AgentRunRequest } from "@bob/contracts/agent"
import type { ToolCommand, ToolName, ToolResult } from "@bob/contracts/tools"

export interface ToolFactoryOptions {
  readonly request: AgentRunRequest
  readonly execute: (command: ToolCommand) => Promise<ToolResult>
}

const schemas = {
  reminder_create: Type.Object({
    displayText: Type.String({ maxLength: 1_200 }),
    smsSafeText: Type.String({ maxLength: 1_200 }),
    localDate: Type.String(),
    localTime: Type.String(),
    timeZone: Type.String(),
    dueAt: Type.String(),
    sourceMessageId: Type.String(),
    requiresAcknowledgment: Type.Boolean()
  }),
  reminder_list: Type.Object({}),
  memory_search: Type.Object({ query: Type.String() }),
  memory_propose: Type.Object({
    scope: Type.String(),
    key: Type.String(),
    value: Type.Unknown(),
    canonicalText: Type.String(),
    assertionKind: Type.Union([
      Type.Literal("user_stated"),
      Type.Literal("system_recorded"),
      Type.Literal("inferred")
    ]),
    originClass: Type.Union([
      Type.Literal("owner_input"),
      Type.Literal("system_record"),
      Type.Literal("recalled_content"),
      Type.Literal("tool_output"),
      Type.Literal("assistant_output"),
      Type.Literal("background_model")
    ]),
    sourceType: Type.String(),
    sourceId: Type.String(),
    extractionConfidence: Type.Number(),
    importance: Type.Number(),
    explicitRemember: Type.Boolean()
  }),
  memory_confirm: Type.Object({ id: Type.String() }),
  journal_link_create: Type.Object({}),
  journal_search_metadata: Type.Object({ tag: Type.Optional(Type.String()) }),
  gym_create: Type.Object({ name: Type.String() }),
  exercise_create: Type.Object({
    name: Type.String(),
    instructions: Type.Optional(Type.String())
  }),
  gym_add_equipment: Type.Object({
    gymId: Type.String(),
    name: Type.String(),
    identifier: Type.Optional(Type.String())
  }),
  equipment_map_exercise: Type.Object({
    equipmentId: Type.String(),
    exerciseId: Type.String()
  }),
  routine_save: Type.Object({
    name: Type.String(),
    steps: Type.Array(
      Type.Object({
        exerciseId: Type.String(),
        targetSets: Type.Optional(Type.Integer()),
        targetReps: Type.Optional(Type.Integer()),
        notes: Type.Optional(Type.String())
      })
    )
  }),
  routine_get: Type.Object({ id: Type.Optional(Type.String()) }),
  workout_start: Type.Object({ routineId: Type.String(), gymId: Type.Optional(Type.String()) }),
  workout_log_set: Type.Object({
    sessionId: Type.String(),
    routineStepId: Type.String(),
    equipmentId: Type.Optional(Type.String()),
    sequence: Type.Integer(),
    repetitions: Type.Integer(),
    weightGrams: Type.Optional(Type.Integer()),
    notes: Type.Optional(Type.String())
  }),
  workout_finish: Type.Object({ id: Type.String() }),
  workout_last: Type.Object({ routineId: Type.Optional(Type.String()) }),
  workout_history: Type.Object({ routineId: Type.Optional(Type.String()) })
} as const

const descriptions: Readonly<Partial<Record<ToolName, string>>> = {
  reminder_create: "Create one confirmed reminder with an absolute local date and time.",
  reminder_list: "List active reminders.",
  memory_search: "Find policy-cleared personal records with source labels.",
  memory_propose: "Propose a memory revision. This does not confirm it.",
  memory_confirm: "Confirm one owner-approved memory candidate.",
  journal_link_create: "Create a private short-lived journal link. Never accept journal text.",
  journal_search_metadata: "Find journal dates, tags, and approved summaries only.",
  gym_create: "Save one gym after owner instruction.",
  exercise_create: "Propose one exercise for owner review.",
  gym_add_equipment: "Save equipment for a gym.",
  equipment_map_exercise: "Propose one equipment-to-exercise mapping for owner review.",
  routine_save: "Save an owner-approved training routine.",
  routine_get: "Get one owner routine and its ordered exercises.",
  workout_start: "Start one workout session.",
  workout_log_set: "Log one set. Safety reports are handled before model execution.",
  workout_finish: "Finish one workout.",
  workout_last: "Get the owner's latest workout and its logged sets.",
  workout_history: "List prior workouts."
}

export function createTools(options: ToolFactoryOptions): AgentTool[] {
  return options.request.allowedTools.flatMap((name) => {
    const schema = schemas[name as keyof typeof schemas]
    if (schema === undefined) return []
    const tool: AgentTool<typeof schema, ToolResult> = {
      name,
      label: name,
      description: descriptions[name] ?? "Run one reviewed Bob domain command.",
      parameters: schema,
      executionMode: "sequential",
      async execute(toolCallId, params) {
        const result = await options.execute({
          runId: options.request.runId,
          toolCallId,
          idempotencyKey: `${options.request.runId}:${toolCallId}`,
          ownerId: options.request.ownerId,
          name,
          arguments: params as ToolCommand["arguments"]
        })
        return {
          content: [{ type: "text", text: JSON.stringify(result) }],
          details: result,
          terminate: !result.ok
        }
      }
    }
    return [tool]
  })
}
