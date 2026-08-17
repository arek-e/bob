import { IsoDateTime, NonEmptyText, ShortText, Uuid } from "@bob/capabilities-types/shared"
import { Schema } from "effect"

export const JournalHandoff = Schema.Struct({
  id: Uuid,
  expiresAt: IsoDateTime,
  path: Schema.String,
  bearerToken: Schema.Literal(false)
})

export const JournalEntryCreate = Schema.Struct({
  handoffId: Uuid,
  text: NonEmptyText,
  tags: Schema.Array(ShortText).check(Schema.isMaxLength(25)),
  approvedSummary: Schema.optionalKey(ShortText)
})

export const JournalEntryUpdate = Schema.Struct({
  text: NonEmptyText,
  tags: Schema.Array(ShortText).check(Schema.isMaxLength(25)),
  approvedSummary: Schema.optionalKey(ShortText)
})

export const JournalMetadata = Schema.Struct({
  id: Uuid,
  createdAt: IsoDateTime,
  tags: Schema.Array(ShortText),
  approvedSummary: Schema.optionalKey(ShortText)
})

export const JournalEntry = Schema.Struct({ ...JournalMetadata.fields, text: NonEmptyText })
export const JournalList = Schema.Struct({ entries: Schema.Array(JournalMetadata) })

export type JournalHandoff = typeof JournalHandoff.Type
export type JournalEntryCreate = typeof JournalEntryCreate.Type
export type JournalEntryUpdate = typeof JournalEntryUpdate.Type
export type JournalMetadata = typeof JournalMetadata.Type
export type JournalEntry = typeof JournalEntry.Type
export type JournalList = typeof JournalList.Type
