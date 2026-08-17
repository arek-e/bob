import type {
  ToolAdapterRegistry,
  ToolCommandAdapter,
  ToolCommandAdapterContext
} from "@bob/tools-types/adapter"

import { withBobSpan } from "@bob/observability"
import {
  capabilityToolNames,
  type CapabilityCatalogue,
  type ToolName
} from "@bob/tools-types/tools"

export type {
  ToolAdapterRegistry,
  ToolCommandAdapter,
  ToolCommandAdapterContext,
  ToolRunContext
} from "@bob/tools-types/adapter"

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

/** Execute one statically registered domain Adapter inside its complete telemetry span. */
export function executeRegisteredTool(
  registry: ToolAdapterRegistry,
  context: ToolCommandAdapterContext
) {
  const adapter = registry.adapterFor(context.command.name)
  if (adapter === undefined) return undefined
  return withBobSpan(
    {
      name: "bob.tool.domain",
      correlationId: context.run.correlationId,
      feature: registry.catalogue.moduleFor(context.command.name)?.feature ?? "assistant",
      runId: context.command.runId,
      toolName: context.command.name
    },
    adapter.execute(context)
  )
}
