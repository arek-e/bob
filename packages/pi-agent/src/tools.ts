import type { AgentRunRequest } from "@bob/contracts/agent"

import {
  conversationMutationIdempotencyKey,
  isReadOnlyToolName,
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

export async function toolCommandForCall(
  request: AgentRunRequest,
  name: ToolName,
  toolCallId: string,
  params: unknown
): Promise<ToolCommand> {
  const argumentsValue = params as ToolCommand["arguments"]
  const idempotencyKey =
    request.conversationTurnId !== undefined && !isReadOnlyToolName(name)
      ? await conversationMutationIdempotencyKey({
          ownerId: request.ownerId,
          conversationTurnId: request.conversationTurnId,
          toolName: name,
          arguments: argumentsValue
        })
      : `${request.runId}:${toolCallId}`
  return {
    runId: request.runId,
    toolCallId,
    idempotencyKey,
    ownerId: request.ownerId,
    name,
    arguments: argumentsValue
  }
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
        return options.execute(await toolCommandForCall(options.request, name, toolCallId, params))
      }
    }
    return [tool]
  })
}
