const maximumRotationWindowMs = 8 * 24 * 60 * 60 * 1_000
const minimumRotationWindowMs = 24 * 60 * 60 * 1_000

export function validateAccessTokenRotation(rotateBy: string, now = new Date()): void {
  const deadline = Date.parse(rotateBy)
  if (!Number.isFinite(deadline)) throw new Error("Access token rotation deadline is invalid")
  const remaining = deadline - now.getTime()
  if (remaining < minimumRotationWindowMs) {
    throw new Error("Access service tokens need rotation within 24 hours")
  }
  if (remaining > maximumRotationWindowMs) {
    throw new Error("Access token rotation deadline exceeds the eight-day gate")
  }
}
