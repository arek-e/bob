import type { AgentRunAttemptAuthority } from "@bob/agent-runs-types/worker-gateway"

import { AsyncLocalStorage } from "node:async_hooks"

export interface AgentExecutionContext {
  readonly ownerId: string
  readonly authority?: () => AgentRunAttemptAuthority
}

const storage = new AsyncLocalStorage<AgentExecutionContext>()

export function withAgentExecutionContext<Value>(
  context: AgentExecutionContext,
  operation: () => Promise<Value>
): Promise<Value> {
  return storage.run(context, operation)
}

export function currentAgentExecutionContext(): AgentExecutionContext | undefined {
  return storage.getStore()
}
