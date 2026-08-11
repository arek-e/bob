export interface JournalRecord {
  readonly id: string
  readonly createdAt: string
  readonly tags: readonly string[]
  readonly approvedSummary?: string
  readonly rawText: string
}

export function journalMetadata(record: JournalRecord) {
  return {
    id: record.id,
    createdAt: record.createdAt,
    tags: record.tags,
    ...(record.approvedSummary === undefined ? {} : { approvedSummary: record.approvedSummary })
  }
}

export function journalModelContext(record: JournalRecord): string | undefined {
  void record
  return undefined
}

export function journalAgentMetadata(
  record: Pick<JournalRecord, "createdAt" | "tags"> &
    Partial<Pick<JournalRecord, "id" | "approvedSummary" | "rawText">>
) {
  return {
    createdAt: record.createdAt,
    tags: record.tags
  }
}
