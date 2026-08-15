import { transitionalDeploymentProfile } from "@bob/contracts/deployment-profiles"

import type { CoreDatabase } from "../src/database.ts"
import type { ConnectionStore } from "../src/modules/connections/store.ts"
import type { JournalStore } from "../src/modules/journal/store.ts"
import type { MemoryStore } from "../src/modules/memory/store.ts"
import type { DataProtection } from "../src/modules/policy/data-protection.ts"
import type { ReminderStore } from "../src/modules/reminders/store.ts"
import type { OwnerSettingsStore } from "../src/modules/settings/store.ts"
import type { TrainingStore } from "../src/modules/training/store.ts"

import { makeConnectionsToolAdapter } from "../src/modules/connections/tool-adapter.ts"
import { makeToolAdapterRegistry } from "../src/modules/conversations/tool-adapter.ts"
import { makeToolExecutor, type ToolExecutor } from "../src/modules/conversations/tool-executor.ts"
import { makeJournalToolAdapter } from "../src/modules/journal/tool-adapter.ts"
import { makeMemoryToolAdapter } from "../src/modules/memory/tool-adapter.ts"
import { makeReminderToolAdapter } from "../src/modules/reminders/tool-adapter.ts"
import { makeRetrievalPipeline } from "../src/modules/retrieval/pipeline.ts"
import { makeSettingsToolAdapter } from "../src/modules/settings/tool-adapter.ts"
import { makeTrainingModule, type TrainingModule } from "../src/modules/training/module.ts"
import { makeTrainingProposalStore } from "../src/modules/training/proposal-store.ts"
import { makeTrainingToolAdapter } from "../src/modules/training/tool-adapter.ts"

interface TestToolModules {
  readonly reminders: ReminderStore
  readonly memory: MemoryStore
  readonly journal: JournalStore
  readonly training: TrainingStore | TrainingModule
  readonly settings?: OwnerSettingsStore
  readonly connections?: ConnectionStore
}

interface TestToolOptions {
  readonly uiBaseUrl: string
  readonly now?: () => Date
  readonly randomUuid?: () => string
  readonly toolLeaseMs?: number
}

type TestToolExecutor = ToolExecutor & {
  listTrainingProposals: TrainingModule["listTrainingProposals"]
  approveTrainingProposal: TrainingModule["approveTrainingProposal"]
}

function isTrainingModule(value: TrainingStore | TrainingModule): value is TrainingModule {
  return "proposeTraining" in value
}

/** Transitional Worker-test composition. Production composition owns this wiring. */
export function makeTestToolExecutor(
  database: CoreDatabase,
  protection: DataProtection,
  modules: TestToolModules,
  options: TestToolOptions
): TestToolExecutor {
  const training = isTrainingModule(modules.training)
    ? modules.training
    : makeTrainingModule(
        modules.training,
        makeTrainingProposalStore(database, protection, modules.training, options)
      )
  const retrieval = makeRetrievalPipeline(database)
  const registry = makeToolAdapterRegistry(transitionalDeploymentProfile, [
    makeReminderToolAdapter(modules.reminders),
    makeMemoryToolAdapter(modules.memory, retrieval),
    makeJournalToolAdapter(
      modules.journal,
      { excludeFromContext: async () => true },
      {
        uiBaseUrl: options.uiBaseUrl
      }
    ),
    makeTrainingToolAdapter(training),
    makeSettingsToolAdapter(modules.settings),
    makeConnectionsToolAdapter(modules.connections)
  ])
  return Object.assign(makeToolExecutor(database, protection, registry, options), {
    listTrainingProposals: training.listTrainingProposals,
    approveTrainingProposal: training.approveTrainingProposal
  })
}
