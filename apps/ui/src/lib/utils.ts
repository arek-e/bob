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
  const values = Intl.supportedValuesOf("timeZone")
  return [...new Set(["UTC", selected, ...values])].sort((left, right) => left.localeCompare(right))
}

export function formatDate(
  value: string,
  locale = navigator.language || "en",
  timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
  hourCycle: "auto" | "h12" | "h23" = "auto"
): string {
  const options: Intl.DateTimeFormatOptions = {
    dateStyle: "full",
    timeStyle: "short",
    timeZone
  }
  if (hourCycle !== "auto") options.hourCycle = hourCycle
  return new Intl.DateTimeFormat(locale, options).format(new Date(value))
}

export function formatDateInTimeZone(
  value: string,
  timeZone: string,
  locale = navigator.language || "en",
  hourCycle: "auto" | "h12" | "h23" = "auto"
): string {
  return formatDate(value, locale, timeZone, hourCycle)
}
