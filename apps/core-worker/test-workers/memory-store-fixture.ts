import type { CoreDatabase } from "../src/database.ts"
import type { DataProtection } from "../src/modules/policy/data-protection.ts"

import { makePrivateTextReader } from "../src/modules/context/private-text.ts"
import { makeConversationEvidenceSource } from "../src/modules/conversations/evidence-source.ts"
import { makeJournalEvidenceSource } from "../src/modules/journal/evidence-source.ts"
import { makeFactEvidenceSource } from "../src/modules/memory/evidence-source.ts"
import { makeEvidenceSourceRegistry } from "../src/modules/memory/evidence.ts"
import { makeMemoryStore } from "../src/modules/memory/store.ts"
import { makeReminderEvidenceSource } from "../src/modules/reminders/evidence-source.ts"
import { makeTrainingEvidenceSource } from "../src/modules/training/evidence-source.ts"

export function makeTestEvidenceSources(database: CoreDatabase, protection: DataProtection) {
  const text = makePrivateTextReader(database, protection)
  return makeEvidenceSourceRegistry("transitional", [
    makeConversationEvidenceSource(database, text, protection),
    makeFactEvidenceSource(database, text, protection),
    makeJournalEvidenceSource(database, protection),
    makeReminderEvidenceSource(database, protection),
    makeTrainingEvidenceSource(database, protection)
  ])
}

export function makeTestMemoryStore(
  database: CoreDatabase,
  protection: DataProtection,
  options: { readonly now?: () => Date; readonly randomUuid?: () => string } = {}
) {
  return makeMemoryStore(
    database,
    protection,
    makeTestEvidenceSources(database, protection),
    options
  )
}
