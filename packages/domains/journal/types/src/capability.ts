import type { CapabilityModule } from "@bob/capabilities-types/definitions"

import { emptyInputSchema } from "@bob/capabilities-types/definitions"
import { ShortText } from "@bob/capabilities-types/shared"
import { Schema } from "effect"

export const JournalSearchMetadataArguments = Schema.Struct({
  tag: Schema.optionalKey(ShortText.check(Schema.isPattern(/\S/)))
})
export type JournalSearchMetadataArguments = typeof JournalSearchMetadataArguments.Type

export const journalCapability = {
  id: "journal",
  version: 1,
  feature: "journal",
  tools: [
    {
      kind: "model",
      name: "journal_link_create",
      description:
        "Create a private short-lived journal link after the owner asks. Never accept journal text.",
      inputSchema: emptyInputSchema,
      confirmedActionCodes: ["journal_link_created"]
    },
    {
      kind: "model",
      name: "journal_search_metadata",
      description: "Find journal dates and tags. Journal text and summaries stay private.",
      inputSchema: {
        type: "object",
        properties: { tag: { type: "string", minLength: 1, maxLength: 1_200, pattern: "\\S" } },
        additionalProperties: false
      },
      readOnly: true
    }
  ]
} as const satisfies CapabilityModule
