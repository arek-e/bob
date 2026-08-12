import type { AgentArtifact } from "@bob/contracts/agent"

export function renderArtifact(artifact: AgentArtifact): string {
  const header = [
    artifact.title,
    ...(artifact.durationMinutes === null ? [] : [`Duration: ${artifact.durationMinutes} minutes`])
  ]
  const sections = artifact.sections.map((section) =>
    [section.heading, ...section.items.map((item, index) => `${index + 1}. ${item}`)].join("\n")
  )
  return [...header, "", sections.join("\n\n")].join("\n")
}
