import { transitionalDeploymentProfile } from "@bob/contracts/deployment-profiles"

import type { CoreDatabase } from "../src/database.ts"
import type { DataProtection } from "../src/modules/policy/data-protection.ts"

import { makeArtifactStore } from "../src/modules/artifacts/store.ts"
import { makeApplicationContextStore } from "../src/modules/context/composition.ts"
import { makeOwnerDataKeyStore } from "../src/modules/policy/owner-data-key.ts"
import { makeRetrievalPipeline } from "../src/modules/retrieval/pipeline.ts"
import { legacyTrainingArtifactReader } from "../src/modules/training/legacy-artifact.ts"

export function makeTestContextStore(database: CoreDatabase, protection: DataProtection) {
  const ownerDataKeys = makeOwnerDataKeyStore(database, protection, { defaultTimeZone: "UTC" })
  return makeApplicationContextStore(database, protection, transitionalDeploymentProfile, {
    artifacts: makeArtifactStore(database, protection, {
      legacyReaders: [legacyTrainingArtifactReader],
      ownerDataKeys
    }),
    retrieval: makeRetrievalPipeline(database),
    ownerDataKeys
  })
}
