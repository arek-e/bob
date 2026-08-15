import type { AgentRunRequest } from "@bob/contracts/agent"

import {
  conversationMutationIdempotencyKey,
  type CapabilityCatalogue,
  type ToolCommand,
  type ToolInputSchema,
  type ToolName,
  type ToolResult
} from "@bob/contracts/tools"
import { Type, type TSchema, type Tool } from "@earendil-works/pi-ai"
import { Schema } from "effect"

export interface ToolFactoryOptions {
  readonly catalogue: CapabilityCatalogue
  readonly request: AgentRunRequest
  readonly execute: (command: ToolCommand) => Promise<ToolResult>
}

/** Bob's executable Pi tool definition. Pi supplies schemas; Bob supplies execution. */
export interface BobPiTool extends Tool {
  readonly label: ToolName
  readonly executionMode: "sequential"
  execute<Input>(toolCallId: string, params: Input): Promise<ToolResult>
}

function toPiParameters(inputSchema: ToolInputSchema): TSchema {
  return Type.Unsafe(inputSchema)
}

export async function toolCommandForCall<Input>(
  catalogue: CapabilityCatalogue,
  request: AgentRunRequest,
  name: ToolName,
  toolCallId: string,
  params: Input
): Promise<ToolCommand> {
  const argumentsValue = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Json))(params)
  const idempotencyKey =
    request.conversationTurnId !== undefined && !catalogue.isReadOnly(name)
      ? await conversationMutationIdempotencyKey({
          ownerId: request.ownerId,
          conversationTurnId: request.conversationTurnId,
          toolName: name,
          arguments: argumentsValue,
          excludedArgumentNames: catalogue.mutationArgumentExclusions(name)
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
    if (options.request.sourceMessageId === undefined && options.catalogue.isSourceBound(name)) {
      return []
    }
    const definition = options.catalogue.definitionFor(name)
    if (definition === undefined) return []
    const tool: BobPiTool = {
      name: definition.name,
      label: name,
      description: definition.description,
      parameters: toPiParameters(definition.inputSchema),
      executionMode: "sequential",
      async execute(toolCallId, params) {
        return options.execute(
          await toolCommandForCall(options.catalogue, options.request, name, toolCallId, params)
        )
      }
    }
    return [tool]
  })
}
