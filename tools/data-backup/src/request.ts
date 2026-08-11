export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000

export function requestTimeoutSignal(timeoutMs: number): AbortSignal {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new Error("Cloudflare request timeout must be a positive integer")
  }
  return AbortSignal.timeout(timeoutMs)
}
