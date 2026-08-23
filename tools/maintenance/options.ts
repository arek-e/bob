import { MaintenanceCliError } from "./cli.js"

export const ENVIRONMENT_NAME = /^[A-Z][A-Z0-9_]*$/u

export function parseOptions(arguments_: readonly string[]): Map<string, string> {
  const parsed = new Map<string, string>()
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index]
    if (argument === undefined || !argument.startsWith("--") || argument.length === 2) {
      throw new MaintenanceCliError("Options must use --name value syntax")
    }
    const name = argument.slice(2)
    if (parsed.has(name)) {
      throw new MaintenanceCliError(`Option --${name} was provided more than once`)
    }
    const value = arguments_[index + 1]
    if (value === undefined || value.startsWith("--")) {
      throw new MaintenanceCliError(`Option --${name} needs a value`)
    }
    parsed.set(name, value)
    index += 1
  }
  return parsed
}

export function requiredOption(
  options: ReadonlyMap<string, string>,
  name: string,
  fallback?: string
): string {
  const value = options.get(name) ?? fallback
  if (value === undefined || value.length === 0) {
    throw new MaintenanceCliError(`Option --${name} is required`)
  }
  return value
}

export function rejectUnknown(
  options: ReadonlyMap<string, string>,
  allowed: readonly string[]
): void {
  for (const name of options.keys()) {
    if (!allowed.includes(name)) {
      throw new MaintenanceCliError(`Option --${name} is not supported`)
    }
  }
}

export function addQuery(query: URLSearchParams, name: string, value: string | undefined): void {
  if (value !== undefined) query.set(name, value)
}

export function withQuery(path: string, query: URLSearchParams): string {
  const search = query.toString()
  return search.length === 0 ? path : `${path}?${search}`
}

export function buildUrl(baseUrl: string, endpoint: string): URL {
  try {
    return new URL(endpoint, baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`)
  } catch {
    throw new MaintenanceCliError("Option --base-url is invalid")
  }
}
