import type { JournalMetadata } from "@bob/contracts/ui"

export function journalIndexMarkdown(
  entries: readonly JournalMetadata[],
  exportedAt: string
): string {
  const lines = [
    "# Bob journal index",
    "",
    `Exported: ${exportedAt}`,
    "",
    "> This file excludes private journal text. It contains dates, tags, and approved summaries.",
    ""
  ]
  for (const entry of entries) {
    lines.push(`## ${entry.createdAt.slice(0, 10)}`)
    lines.push("")
    lines.push(`- Bob entry ID: \`${entry.id}\``)
    lines.push(`- Tags: ${entry.tags.length === 0 ? "None" : entry.tags.join(", ")}`)
    lines.push(`- Approved summary: ${entry.approvedSummary ?? "None"}`)
    lines.push("")
  }
  return lines.join("\n")
}
