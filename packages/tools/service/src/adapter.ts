import type { ToolResult } from "@bob/tools-types/tools"

import { ToolAdapterError } from "@bob/tools-types/adapter"
import { Effect } from "effect"

/** Keep one typed Effect seam while a domain Adapter calls Promise-based persistence ports. */
export function fromPromiseToolExecution(
  capabilityId: string,
  execute: () => Promise<ToolResult>
): Effect.Effect<ToolResult, ToolAdapterError> {
  return Effect.tryPromise({
    try: execute,
    catch: (cause) => new ToolAdapterError({ capabilityId, operation: "execute", cause })
  })
}
