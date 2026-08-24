import { secretMatches } from "./access.ts"

export interface HeadlessApiAccessConfiguration {
  readonly apiKey: string
  readonly ownerId?: string
}

export interface HeadlessApiPrincipal {
  readonly ownerId?: string
}

function bearerToken(request: Request): string | null {
  const value = request.headers.get("authorization")
  if (value === null) return null
  const match = /^Bearer\s+(\S+)$/u.exec(value)
  return match?.[1] ?? null
}

export async function authorizeHeadlessApiRequest(
  request: Request,
  configuration: HeadlessApiAccessConfiguration
): Promise<HeadlessApiPrincipal> {
  if (!(await secretMatches(bearerToken(request), configuration.apiKey))) {
    throw new Error("access_denied")
  }
  return configuration.ownerId === undefined ? {} : { ownerId: configuration.ownerId }
}
