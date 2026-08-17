import type { AgentRunRequest } from "@bob/agent-types/run"

import {
  conversationMutationIdempotencyKey,
  type CapabilityCatalogue,
  type ToolCommand,
  type ToolInputSchema,
  type ToolName
} from "@bob/capabilities-types/tools"
import { Type, type TSchema, type Tool } from "@earendil-works/pi-ai"
import { Schema } from "effect"

export interface ToolFactoryOptions {
  readonly catalogue: CapabilityCatalogue
  readonly request: AgentRunRequest
}

/** Bob's catalogue-derived Pi tool metadata. The Agent loop owns execution. */
export interface AgentTool extends Tool {
  readonly label: ToolName
  readonly executionMode: "sequential"
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

export function createTools(options: ToolFactoryOptions): AgentTool[] {
  return options.request.allowedTools.flatMap((name) => {
    if (options.request.sourceMessageId === undefined && options.catalogue.isSourceBound(name)) {
      return []
    }
    const definition = options.catalogue.definitionFor(name)
    if (definition === undefined) return []
    const tool: AgentTool = {
      name: definition.name,
      label: name,
      description: definition.description,
      parameters: toPiParameters(definition.inputSchema),
      executionMode: "sequential"
    }
    return [tool]
  })
}
