import { AgentArtifact, type AgentArtifact as AgentArtifactValue } from "@bob/contracts/agent"
import { and, desc, eq } from "drizzle-orm"
import { Context, Layer, Schema } from "effect"

import type { CoreDatabase } from "../../database.ts"
import type { DataProtection } from "../policy/data-protection.ts"

import { users } from "../conversations/schema.ts"
import { artifactRevisions, artifacts } from "./schema.ts"

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
  options: { readonly legacyReaders?: readonly LegacyArtifactReader[] } = {}
): ArtifactStore {
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
  async function ownerKey(ownerId: string): Promise<CryptoKey> {
    const [owner] = await database.select().from(users).where(eq(users.id, ownerId)).limit(1)
    if (
      owner?.wrappedDataKey === null ||
      owner?.wrappedDataKey === undefined ||
      owner.wrappedDataKeyIv === null ||
      owner.wrappedDataKeyIv === undefined ||
      owner.dataKeyVersion === null ||
      owner.dataKeyVersion === undefined
    ) {
      throw new Error("Owner data key is unavailable")
    }
    return protection.unwrapDataKey({
      ciphertext: owner.wrappedDataKey,
      iv: owner.wrappedDataKeyIv,
      version: owner.dataKeyVersion
    })
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
      const key = await ownerKey(ownerId)
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
