import { createAuthClient } from "better-auth/client"

import { apiBase } from "~/lib/api"

export interface OwnerSession {
  readonly user: {
    readonly email: string
    readonly name: string
  }
}

const authClient = createAuthClient(apiBase.length === 0 ? {} : { baseURL: apiBase })

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
  const result = await authClient.getSession()
  if (result.error !== null) {
    if (result.error.status === 401) return null
    throw new Error("Unable to load the owner session")
  }
  return decodeOwnerSession(result.data)
}

export async function signInOwner(email: string, password: string): Promise<boolean> {
  const result = await authClient.signIn.email({ email, password, rememberMe: true })
  return result.error === null
}

export async function signOutOwner(): Promise<void> {
  const result = await authClient.signOut()
  if (result.error !== null) throw new Error("Unable to sign out")
}
