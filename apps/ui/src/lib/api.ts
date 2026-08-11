import { ConnectionSession } from "@bob/contracts/settings"
import { Schema } from "effect"

export interface OwnerSession {
  readonly user: {
    readonly email: string
    readonly name: string
  }
}

export const apiBase = __BOB_API_BASE_URL__

export async function api(path: string, init?: RequestInit): Promise<unknown> {
  const method = init?.method?.toUpperCase() ?? "GET"
  const headers = new Headers(init?.headers)
  headers.set("content-type", "application/json")
  if (method !== "GET" && method !== "HEAD" && !headers.has("idempotency-key")) {
    headers.set("idempotency-key", crypto.randomUUID())
  }

  const response = await fetch(`${apiBase}${path}`, { ...init, headers })
  const contentType = response.headers.get("content-type") ?? ""
  const value = contentType.includes("application/json")
    ? ((await response.json()) as unknown)
    : null
  if (response.status === 401) {
    if (typeof window !== "undefined") {
      const returnTo = `${window.location.pathname}${window.location.search}${window.location.hash}`
      window.location.assign(`/sign-in?returnTo=${encodeURIComponent(returnTo)}`)
    }
    throw new Error("unauthorized")
  }
  if (!response.ok) throw new Error(`Request failed with status ${response.status}`)
  return value
}

export function safeReturnPath(): string {
  if (typeof window === "undefined") return "/settings"
  const value = new URLSearchParams(window.location.search).get("returnTo")
  return value !== null && value.startsWith("/") && !value.startsWith("//") ? value : "/settings"
}

function decodeOwnerSession(value: unknown): OwnerSession | null {
  if (typeof value !== "object" || value === null || !("user" in value)) return null
  const user = (value as { user?: unknown }).user
  if (typeof user !== "object" || user === null) return null
  const email = "email" in user ? (user as { email?: unknown }).email : undefined
  const name = "name" in user ? (user as { name?: unknown }).name : undefined
  if (typeof email !== "string" || typeof name !== "string") return null
  return { user: { email, name } }
}

export async function loadOwnerSession(): Promise<OwnerSession | null> {
  const response = await fetch(`${apiBase}/api/auth/get-session`, {
    headers: { accept: "application/json" }
  })
  if (!response.ok) return null
  return decodeOwnerSession((await response.json()) as unknown)
}

export function parseJson<S extends Schema.ConstraintDecoder<unknown>>(
  schema: S,
  value: unknown
): S["Type"] {
  return Schema.decodeUnknownSync(schema)(value)
}

export const schemas = {
  connectionSession: ConnectionSession
} as const
