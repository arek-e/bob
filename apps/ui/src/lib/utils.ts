import { clsx, type ClassValue } from "clsx"

export function cn(...inputs: ClassValue[]): string {
  return clsx(inputs)
}

export function parseTags(value: string): string[] {
  return value
    .split(",")
    .map((tag) => tag.trim())
    .filter((tag) => tag.length > 0)
}

export function supportedTimeZones(selected: string): readonly string[] {
  const supportedValuesOf = (
    Intl as typeof Intl & { supportedValuesOf?: (key: "timeZone") => string[] }
  ).supportedValuesOf
  const values = supportedValuesOf?.("timeZone") ?? []
  return [...new Set(["UTC", selected, ...values])].sort((left, right) => left.localeCompare(right))
}

export function formatDate(
  value: string,
  locale = typeof navigator === "undefined" ? "en" : navigator.language || "en",
  timeZone = typeof Intl === "undefined"
    ? "UTC"
    : Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
  hourCycle: "auto" | "h12" | "h23" = "auto"
): string {
  return new Intl.DateTimeFormat(locale, {
    dateStyle: "full",
    timeStyle: "short",
    timeZone,
    ...(hourCycle === "auto" ? {} : { hourCycle })
  }).format(new Date(value))
}

export function formatDateInTimeZone(
  value: string,
  timeZone: string,
  locale = typeof navigator === "undefined" ? "en" : navigator.language || "en",
  hourCycle: "auto" | "h12" | "h23" = "auto"
): string {
  return formatDate(value, locale, timeZone, hourCycle)
}
