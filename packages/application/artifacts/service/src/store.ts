import type { CoreDatabase } from "@bob/db-types"
import type { DataProtection } from "@bob/policy-types/data-protection"
import type { OwnerDataKeyStoreAdapter } from "@bob/policy-types/owner-data-key"

import {
  AgentArtifact,
  type AgentArtifact as AgentArtifactValue
} from "@bob/artifacts-types/artifact"
import {
  ArtifactStore,
  type ArtifactStoreAdapter,
  ArtifactStoreError,
  type LegacyArtifactReader
} from "@bob/artifacts-types/store"
import { artifactRevisions, artifacts } from "@bob/db-service/schema/artifacts"
import { makeOwnerDataKeyStore } from "@bob/policy-service/owner-data-key"
import { and, desc, eq } from "drizzle-orm"
import { Effect, Layer, Schema } from "effect"

export {
  ArtifactStore,
  type ArtifactStoreAdapter,
  type LegacyArtifactReader,
  type StoredArtifact
} from "@bob/artifacts-types/store"

export function makeArtifactStore(
  database: CoreDatabase,
  protection: DataProtection,
  options: {
    readonly legacyReaders?: readonly LegacyArtifactReader[]
    readonly ownerDataKeys?: OwnerDataKeyStoreAdapter
  } = {}
): ArtifactStoreAdapter {
  const ownerDataKeys =
    options.ownerDataKeys ?? makeOwnerDataKeyStore(database, protection, { defaultTimeZone: "UTC" })
  function decodeArtifact(value: typeof Schema.Json.Type): AgentArtifactValue {
    try {
      return Schema.decodeUnknownSync(AgentArtifact)(value)
    } catch (error) {
      for (const reader of options.legacyReaders ?? []) {
        const artifact = reader.read(value)
        if (artifact !== undefined) return artifact
      }
      throw error
    }
  }
  return {
    async latest(ownerId, channelId) {
      const [row] = await Effect.runPromise(
        database
          .select({ artifact: artifacts, revision: artifactRevisions })
          .from(artifacts)
          .innerJoin(
            artifactRevisions,
            and(
              eq(artifactRevisions.artifactId, artifacts.id),
              eq(artifactRevisions.revision, artifacts.currentRevision)
            )
          )
          .where(and(eq(artifacts.userId, ownerId), eq(artifacts.channelId, channelId)))
          .orderBy(desc(artifacts.updatedAt))
          .limit(1)
      )
      if (row === undefined) return undefined
      const key = (await ownerDataKeys.load(ownerId)).key
      const [content, renderedText] = await Promise.all([
        protection.decryptText(key, {
          ciphertext: row.revision.contentCiphertext,
          iv: row.revision.contentIv
        }),
        protection.decryptText(key, {
          ciphertext: row.revision.renderedTextCiphertext,
          iv: row.revision.renderedTextIv
        })
      ])
      return {
        id: row.artifact.id,
        revision: row.revision.revision,
        artifact: decodeArtifact(Schema.decodeUnknownSync(Schema.Json)(JSON.parse(content))),
        renderedText
      }
    }
  }
}

export function artifactStoreLayer(store: ArtifactStoreAdapter) {
  return Layer.succeed(ArtifactStore, {
    latest: Effect.fnUntraced(function* (ownerId: string, channelId: string) {
      return yield* Effect.tryPromise({
        try: () => store.latest(ownerId, channelId),
        catch: (cause) => new ArtifactStoreError({ cause })
      })
    })
  })
}
