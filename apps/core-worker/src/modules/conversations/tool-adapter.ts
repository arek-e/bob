import type { AgentRunRequest } from "@bob/contracts/agent"
import type {
  CapabilityCatalogue,
  CapabilityId,
  ToolCommand,
  ToolName,
  ToolResult
} from "@bob/contracts/tools"

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
  readonly capabilityId: CapabilityId
  readonly names: readonly ToolName[]
  execute(context: ToolCommandAdapterContext): Promise<ToolResult>
}

export interface ToolAdapterRegistry {
  readonly catalogue: CapabilityCatalogue
  adapterFor(name: ToolName): ToolCommandAdapter | undefined
}

export function makeToolAdapterRegistry(
  catalogue: CapabilityCatalogue,
  adapters: readonly ToolCommandAdapter[]
): ToolAdapterRegistry {
  const catalogueById = new Map(catalogue.modules.map((module) => [module.id, module]))
  const adapterByName = new Map<ToolName, ToolCommandAdapter>()

  for (const adapter of adapters) {
    const capability = catalogueById.get(adapter.capabilityId)
    if (capability === undefined) {
      throw new Error(`Adapter ${adapter.capabilityId} is not in profile ${catalogue.profileId}`)
    }
    if (
      adapter.names.length !== capability.names.length ||
      adapter.names.some((name) => !capability.names.includes(name))
    ) {
      throw new Error(`Adapter ${adapter.capabilityId} does not match its Capability Module`)
    }
    for (const name of adapter.names) {
      if (adapterByName.has(name)) throw new Error(`Duplicate Tool Adapter for ${name}`)
      adapterByName.set(name, adapter)
    }
  }

  const missing = catalogue.names.filter((name) => !adapterByName.has(name))
  if (missing.length > 0) throw new Error(`Missing Tool Adapter for ${missing.join(", ")}`)

  return Object.freeze({
    catalogue,
    adapterFor: (name: ToolName) => adapterByName.get(name)
  })
}
