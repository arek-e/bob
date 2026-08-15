export interface JournalRecord {
  readonly id: string
  readonly createdAt: string
  readonly tags: readonly string[]
  readonly approvedSummary?: string
  readonly rawText: string
}

interface JournalMetadata {
  id: string
  createdAt: string
  tags: readonly string[]
  approvedSummary?: string
}

export function journalMetadata(record: JournalRecord) {
  const metadata: JournalMetadata = {
    id: record.id,
    createdAt: record.createdAt,
    tags: record.tags
  }
  if (record.approvedSummary !== undefined) metadata.approvedSummary = record.approvedSummary
  return metadata
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
