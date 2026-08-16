import type { CoreDatabase } from "@bob/core-types/database"

import { AgentArtifact, type AgentArtifact as AgentArtifactValue } from "@bob/core-types/agent"
import { artifactRevisions, artifacts } from "@bob/db-service/schema/artifacts"
import { and, desc, eq } from "drizzle-orm"
import { Context, Layer, Schema } from "effect"

import type { DataProtection } from "../policy/data-protection.ts"
import type { OwnerDataKeyStore } from "../policy/owner-data-key.ts"

import { makeOwnerDataKeyStore } from "../policy/owner-data-key.ts"

export interface StoredArtifact {
  readonly id: string
  readonly revision: number
  readonly artifact: AgentArtifactValue
  readonly renderedText: string
}

export interface ArtifactStore {
  latest(ownerId: string, channelId: string): Promise<StoredArtifact | undefined>
}

export const ArtifactStore = Context.Service<ArtifactStore>("bob/ArtifactStore")

export interface LegacyArtifactReader {
  read(value: typeof Schema.Json.Type): AgentArtifactValue | undefined
}

export function makeArtifactStore(
  database: CoreDatabase,
  protection: DataProtection,
  options: {
    readonly legacyReaders?: readonly LegacyArtifactReader[]
    readonly ownerDataKeys?: OwnerDataKeyStore
  } = {}
): ArtifactStore {
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
      const [row] = await database
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

export function artifactStoreLayer(store: ArtifactStore) {
  return Layer.succeed(ArtifactStore, store)
}
