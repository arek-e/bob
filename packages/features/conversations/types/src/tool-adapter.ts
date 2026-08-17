import type { AgentRunRequest } from "@bob/agent-types/run"
import type {
  CapabilityCatalogue,
  CapabilityId,
  ToolCommand,
  ToolName,
  ToolResult
} from "@bob/capabilities-types/tools"

export interface ToolCommandAdapterContext {
  readonly command: ToolCommand
  readonly run: ToolRunContext
}

export interface ToolRunContext {
  readonly request: AgentRunRequest
  readonly channelId: string
  readonly messageId: string
}

export interface ToolCommandAdapter {
  readonly capabilityId: CapabilityId
  readonly names: readonly ToolName[]
  execute(context: ToolCommandAdapterContext): Promise<ToolResult>
}

export interface ToolAdapterRegistry {
  readonly catalogue: CapabilityCatalogue
  adapterFor(name: ToolName): ToolCommandAdapter | undefined
}
