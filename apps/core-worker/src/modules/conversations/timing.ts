export const conversationTiming = {
  modelDurationMs: 60_000,
  mutationRequestTimeoutMs: 65_000,
  coreAgentTimeoutMs: 130_000,
  activeLeaseMs: 140_000,
  mutationSettleLeaseMs: 70_000,
  agentRunRetryDelayMs: 30_000,
  maxAgentRunAttempts: 3
} as const
