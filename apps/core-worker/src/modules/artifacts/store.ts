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

export function makeArtifactStore(
  database: CoreDatabase,
  protection: DataProtection
): ArtifactStore {
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
        artifact: Schema.decodeUnknownSync(AgentArtifact)(JSON.parse(content) as unknown),
        renderedText
      }
    }
  }
}

export function artifactStoreLayer(store: ArtifactStore) {
  return Layer.succeed(ArtifactStore, store)
}
