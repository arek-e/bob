import { Context, type Effect, Schema } from "effect"

import type { AgentArtifact } from "./artifact.ts"

export interface StoredArtifact {
  readonly id: string
  readonly revision: number
  readonly artifact: AgentArtifact
  readonly renderedText: string
}

export interface ArtifactStoreAdapter {
  latest(ownerId: string, channelId: string): Promise<StoredArtifact | undefined>
}

export class ArtifactStoreError extends Schema.TaggedError<ArtifactStoreError>()(
  "ArtifactStoreError",
  { cause: Schema.Unknown }
) {}

export class ArtifactStore extends Context.Service<
  ArtifactStore,
  {
    readonly latest: (
      ownerId: string,
      channelId: string
    ) => Effect.Effect<StoredArtifact | undefined, ArtifactStoreError>
  }
>()("@bob/artifacts/ArtifactStore") {}

export interface LegacyArtifactReader {
  read(value: typeof Schema.Json.Type): AgentArtifact | undefined
}
