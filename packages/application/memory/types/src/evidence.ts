export type MemoryClass = "owner_fact" | "owner_episode" | "agent_experience"

export interface EvidenceReference {
  readonly ownerId: string
  readonly sourceType: string
  readonly sourceId: string
}

export interface VerifiedEvidence {
  readonly sourceLabel: string
  readonly occurredAt?: string
  readonly contentHash: string
  readonly originClass:
    | "owner_input"
    | "system_record"
    | "recalled_content"
    | "tool_output"
    | "assistant_output"
    | "background_model"
  readonly sensitivity: "normal" | "private" | "high"
  readonly confirmationAuthority: "owner_ui" | "completed_system_command" | "never"
  readonly disclosure: "model_and_channel" | "private"
}

export interface EvidenceSourceAdapter {
  readonly id: string
  readonly sourceTypes: readonly string[]
  verify(reference: EvidenceReference): Promise<VerifiedEvidence | undefined>
}

export interface EvidenceSourceRegistry {
  readonly profileId: string
  readonly adapters: readonly EvidenceSourceAdapter[]
  verify(reference: EvidenceReference): Promise<VerifiedEvidence>
}
