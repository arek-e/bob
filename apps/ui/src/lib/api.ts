import { ConnectionSession } from "@bob/contracts/settings"
import { Schema } from "effect"

export interface OwnerSession {
  readonly user: {
    readonly email: string
    readonly name: string
  }
}

const OwnerSessionSchema = Schema.Struct({
  user: Schema.Struct({
    email: Schema.String,
    name: Schema.String
  })
})

export const apiBase = __BOB_API_BASE_URL__

export async function api(path: string, init?: RequestInit): Promise<typeof Schema.Json.Type> {
  const method = init?.method?.toUpperCase() ?? "GET"
  const headers = new Headers(init?.headers)
  headers.set("content-type", "application/json")
  if (method !== "GET" && method !== "HEAD" && !headers.has("idempotency-key")) {
    headers.set("idempotency-key", crypto.randomUUID())
  }

  const response = await fetch(`${apiBase}${path}`, { ...init, headers })
  const contentType = response.headers.get("content-type") ?? ""
  const value = contentType.includes("application/json")
    ? Schema.decodeUnknownSync(Schema.Json)(await response.json())
    : null
  if (response.status === 401) {
    const returnTo = `${window.location.pathname}${window.location.search}${window.location.hash}`
    window.location.assign(`/sign-in?returnTo=${encodeURIComponent(returnTo)}`)
    throw new Error("unauthorized")
  }
  if (!response.ok) throw new Error(`Request failed with status ${response.status}`)
  return value
}

export function safeReturnPath(): string {
  const value = new URLSearchParams(window.location.search).get("returnTo")
  return value !== null && value.startsWith("/") && !value.startsWith("//") ? value : "/settings"
}

export async function loadOwnerSession(): Promise<OwnerSession | null> {
  const response = await fetch(`${apiBase}/api/auth/get-session`, {
    headers: { accept: "application/json" }
  })
  if (!response.ok) return null
  const result = Schema.decodeUnknownExit(OwnerSessionSchema)(await response.json())
  return result._tag === "Success" ? result.value : null
}

export function parseJson<S extends Schema.ConstraintDecoder<unknown>, Input>(
  schema: S,
  value: Input
): S["Type"] {
  return Schema.decodeUnknownSync(schema)(value)
}

export const schemas = {
  connectionSession: ConnectionSession
} as const
