import type { AgentArtifact } from "@bob/artifacts-types/artifact"
import type { CoreDatabase, DatabaseQuery } from "@bob/db-types"
import type { DataProtection } from "@bob/policy-types/data-protection"
import type { OwnerDataKeyStoreAdapter } from "@bob/policy-types/owner-data-key"

import { artifactRevisions, artifacts } from "@bob/db-service/schema/artifacts"
import { agentRuns, messages } from "@bob/db-service/schema/conversations"
import { outboxMessages } from "@bob/db-service/schema/delivery"
import { and, eq, sql } from "drizzle-orm"
import { Effect } from "effect"

import { renderArtifact } from "./render.ts"

export interface ArtifactRunRevisionInput {
  readonly ownerId: string
  readonly channelId: string
  readonly artifact: AgentArtifact
  readonly sourceIds: readonly string[]
  readonly runId: string
  readonly correlationId: string
  readonly dependsOnOutboxId: string
  readonly createdAt: string
  readonly attemptId?: string
}

export interface ArtifactRunRevisionPlan {
  readonly artifactId: string
  readonly revision: number
  readonly outboxId: string
  readonly statements: readonly [DatabaseQuery, ...DatabaseQuery[]]
}

export interface ArtifactPersistence {
  prepareRunRevision(input: ArtifactRunRevisionInput): Promise<ArtifactRunRevisionPlan>
}

export function makeArtifactPersistence(
  database: CoreDatabase,
  protection: DataProtection,
  ownerDataKeys: OwnerDataKeyStoreAdapter,
  options: { readonly randomUuid?: () => string } = {}
): ArtifactPersistence {
  const randomUuid = options.randomUuid ?? (() => crypto.randomUUID())

  return {
    async prepareRunRevision(input) {
      const [currentArtifact] = await Effect.runPromise(
        database
          .select({ id: artifacts.id, currentRevision: artifacts.currentRevision })
          .from(artifacts)
          .where(
            and(
              eq(artifacts.userId, input.ownerId),
              eq(artifacts.channelId, input.channelId),
              eq(artifacts.kind, input.artifact.kind)
            )
          )
          .limit(1)
      )
      const owner = await ownerDataKeys.load(input.ownerId)
      const artifactId = currentArtifact?.id ?? randomUuid()
      const revision = (currentArtifact?.currentRevision ?? 0) + 1
      const messageId = randomUuid()
      const outboxId = randomUuid()
      const renderedText = renderArtifact(input.artifact)
      const [encryptedContent, encryptedRenderedText] = await Promise.all([
        protection.encryptText(owner.key, JSON.stringify(input.artifact)),
        protection.encryptText(owner.key, renderedText)
      ])
      const sourceIdsJson = JSON.stringify(input.sourceIds)
      const activeAttempt =
        input.attemptId === undefined
          ? undefined
          : and(
              eq(agentRuns.id, input.runId),
              eq(agentRuns.status, "executing"),
              eq(agentRuns.activeAttemptId, input.attemptId)
            )

      const statements: [DatabaseQuery, ...DatabaseQuery[]] =
        activeAttempt === undefined
          ? [
              currentArtifact === undefined
                ? database.insert(artifacts).values({
                    id: artifactId,
                    userId: input.ownerId,
                    channelId: input.channelId,
                    kind: input.artifact.kind,
                    currentRevision: revision,
                    createdAt: input.createdAt,
                    updatedAt: input.createdAt
                  })
                : database
                    .update(artifacts)
                    .set({ currentRevision: revision, updatedAt: input.createdAt })
                    .where(eq(artifacts.id, artifactId)),
              database.insert(artifactRevisions).values({
                artifactId,
                revision,
                contentCiphertext: encryptedContent.ciphertext,
                contentIv: encryptedContent.iv,
                renderedTextCiphertext: encryptedRenderedText.ciphertext,
                renderedTextIv: encryptedRenderedText.iv,
                dataKeyVersion: owner.version,
                sourceIdsJson,
                createdByRunId: input.runId,
                createdAt: input.createdAt
              }),
              database.insert(messages).values({
                id: messageId,
                userId: input.ownerId,
                channelId: input.channelId,
                direction: "outbound",
                textCiphertext: encryptedRenderedText.ciphertext,
                textIv: encryptedRenderedText.iv,
                dataKeyVersion: owner.version,
                occurredAt: input.createdAt,
                createdAt: input.createdAt
              }),
              database.insert(outboxMessages).values({
                id: outboxId,
                userId: input.ownerId,
                channelId: input.channelId,
                messageId,
                reasonCode: "agent_artifact",
                correlationId: input.correlationId,
                idempotencyKey: `run:${input.runId}:artifact:${input.artifact.kind}`,
                dependsOnOutboxId: input.dependsOnOutboxId,
                artifactId,
                artifactRevision: revision,
                state: "pending",
                createdAt: input.createdAt
              })
            ]
          : [
              currentArtifact === undefined
                ? database.insert(artifacts).select(sql`
                    SELECT
                      ${artifactId},
                      ${agentRuns.userId},
                      ${input.channelId},
                      ${input.artifact.kind},
                      ${revision},
                      ${input.createdAt},
                      ${input.createdAt}
                    FROM ${agentRuns}
                    WHERE ${activeAttempt}
                  `)
                : database
                    .update(artifacts)
                    .set({ currentRevision: revision, updatedAt: input.createdAt })
                    .where(
                      and(
                        eq(artifacts.id, artifactId),
                        sql`EXISTS (SELECT 1 FROM ${agentRuns} WHERE ${activeAttempt})`
                      )
                    ),
              database.insert(artifactRevisions).select(sql`
                SELECT
                  ${artifactId},
                  ${revision},
                  ${encryptedContent.ciphertext},
                  ${encryptedContent.iv},
                  ${encryptedRenderedText.ciphertext},
                  ${encryptedRenderedText.iv},
                  ${owner.version},
                  ${sourceIdsJson},
                  ${input.runId},
                  ${input.createdAt}
                FROM ${agentRuns}
                WHERE ${activeAttempt}
              `),
              database.insert(messages).select(sql`
                SELECT
                  ${messageId},
                  ${agentRuns.userId},
                  ${input.channelId},
                  ${"outbound"},
                  ${encryptedRenderedText.ciphertext},
                  ${encryptedRenderedText.iv},
                  ${owner.version},
                  ${input.createdAt},
                  ${input.createdAt}
                FROM ${agentRuns}
                WHERE ${activeAttempt}
              `),
              database.insert(outboxMessages).select(sql`
                SELECT
                  ${outboxId},
                  ${agentRuns.userId},
                  ${input.channelId},
                  ${messageId},
                  ${"agent_artifact"},
                  ${input.correlationId},
                  ${`run:${input.runId}:artifact:${input.artifact.kind}`},
                  NULL,
                  NULL,
                  NULL,
                  NULL,
                  NULL,
                  ${input.dependsOnOutboxId},
                  ${artifactId},
                  ${revision},
                  ${"pending"},
                  NULL,
                  NULL,
                  NULL,
                  NULL,
                  NULL,
                  0,
                  0,
                  NULL,
                  ${input.createdAt}
                FROM ${agentRuns}
                WHERE ${activeAttempt}
              `)
            ]

      return { artifactId, revision, outboxId, statements }
    }
  }
}
