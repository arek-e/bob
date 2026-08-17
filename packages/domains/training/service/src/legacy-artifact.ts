import type { LegacyArtifactReader } from "@bob/artifacts-service/store"

import { PlanArtifact, type AgentArtifact } from "@bob/artifacts-types/artifact"
import { Option, Schema } from "effect"

const JsonRecord = Schema.Record(Schema.String, Schema.Json)

/** Reads stored Training artifacts without adding Training to the live Agent contract. */
export const legacyTrainingArtifactReader: LegacyArtifactReader = {
  read(value): AgentArtifact | undefined {
    const decoded = Schema.decodeUnknownOption(JsonRecord)(value)
    if (Option.isNone(decoded) || decoded.value.kind !== "training_plan") return undefined
    return Schema.decodeUnknownSync(PlanArtifact)({ ...decoded.value, kind: "plan" })
  }
}
