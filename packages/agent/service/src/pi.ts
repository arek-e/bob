import { piAgentLayerWithDependencies, type PiAgentLayerOptions } from "./internal/pi-runtime.ts"

export type { PiAgentLayerOptions }

export function piAgentLayer(options: PiAgentLayerOptions) {
  return piAgentLayerWithDependencies(options)
}
