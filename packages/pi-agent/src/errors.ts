export type BobAgentErrorCode =
  | "authentication"
  | "quota"
  | "timeout"
  | "cancelled"
  | "provider"
  | "policy"
  | "invalid_output"

export class BobAgentError extends Error {
  constructor(
    readonly code: BobAgentErrorCode,
    message: string
  ) {
    super(message)
    this.name = "BobAgentError"
  }
}

/** Classify provider failures without exposing provider-specific text. */
export function classifyProviderError(message: string | undefined): BobAgentErrorCode {
  const normalized = message?.toLowerCase() ?? ""
  if (/auth|oauth|token|unauthorized|forbidden|401|403/.test(normalized)) return "authentication"
  if (/quota|limit|rate|429|usage/.test(normalized)) return "quota"
  if (/abort|cancel/.test(normalized)) return "cancelled"
  if (/timeout|timed out/.test(normalized)) return "timeout"
  return "provider"
}
