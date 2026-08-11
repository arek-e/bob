import type { AgentRunRequest } from "@bob/contracts/agent"
import type { ToolCommand, ToolResult } from "@bob/contracts/tools"

/**
 * The context that a domain-owned Tool command Adapter may use.
 *
 * The ToolExecutor builds this value only after it has validated the Agent
 * run. Adapters therefore do not read Agent run or Tool call rows directly.
 */
export interface ToolCommandAdapterContext {
  readonly command: ToolCommand
  readonly run: ToolRunContext
}

export interface ToolRunContext {
  readonly request: AgentRunRequest
  readonly channelId: string
  readonly messageId: string
}

/**
 * Internal seam for domain-owned Tool command behavior.
 *
 * The executor selects Adapters with an explicit dispatch statement. This is
 * not a runtime registry or a plugin mechanism.
 */
export interface ToolCommandAdapter {
  execute(context: ToolCommandAdapterContext): Promise<ToolResult>
}
