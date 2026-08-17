import type { ToolAdapterRegistry, ToolCommandAdapter } from "@bob/conversations-types/tool-adapter"

import {
  capabilityToolNames,
  type CapabilityCatalogue,
  type ToolName
} from "@bob/capabilities-types/tools"

export type {
  ToolAdapterRegistry,
  ToolCommandAdapter,
  ToolCommandAdapterContext,
  ToolRunContext
} from "@bob/conversations-types/tool-adapter"

/**
 * The context that a domain-owned Tool command Adapter may use.
 *
 * The ToolExecutorAdapter builds this value only after it has validated the Agent
 * run. Adapters therefore do not read Agent run or Tool call rows directly.
 */
/**
 * Internal seam for domain-owned Tool command behavior.
 *
 * The executor selects Adapters with an explicit dispatch statement. This is
 * not a runtime registry or a plugin mechanism.
 */
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
      adapter.names.length !== capabilityToolNames(capability).length ||
      adapter.names.some((name) => !capabilityToolNames(capability).includes(name))
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
