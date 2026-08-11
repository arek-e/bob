import type { AgentRunRequest } from "@bob/contracts/agent"

import {
  toolDefinitionForName,
  type ToolCommand,
  type ToolInputSchema,
  type ToolName,
  type ToolResult
} from "@bob/contracts/tools"
import { Type, type TSchema, type Tool } from "@earendil-works/pi-ai"

export interface ToolFactoryOptions {
  readonly request: AgentRunRequest
  readonly execute: (command: ToolCommand) => Promise<ToolResult>
}

/** Bob's executable Pi tool definition. Pi supplies schemas; Bob supplies execution. */
export interface BobPiTool extends Tool {
  readonly label: ToolName
  readonly executionMode: "sequential"
  execute(toolCallId: string, params: unknown): Promise<ToolResult>
}

const sourceBoundMutationTools = new Set<ToolName>(["memory_propose", "reminder_create"])

function toPiParameters(inputSchema: ToolInputSchema): TSchema {
  return Type.Unsafe(inputSchema)
}

export function createTools(options: ToolFactoryOptions): BobPiTool[] {
  return options.request.allowedTools.flatMap((name) => {
    if (options.request.sourceMessageId === undefined && sourceBoundMutationTools.has(name)) {
      return []
    }
    const definition = toolDefinitionForName(name)
    if (definition === undefined) return []
    const tool: BobPiTool = {
      name: definition.name,
      label: name,
      description: definition.description,
      parameters: toPiParameters(definition.inputSchema),
      executionMode: "sequential",
      async execute(toolCallId, params) {
        return options.execute({
          runId: options.request.runId,
          toolCallId,
          idempotencyKey: `${options.request.runId}:${toolCallId}`,
          ownerId: options.request.ownerId,
          name,
          arguments: params as ToolCommand["arguments"]
        })
      }
    }
    return [tool]
  })
}
