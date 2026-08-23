import type { CoreDatabase } from "@bob/db-types"
import type {
  ProductionDataAgentRun,
  ProductionDataCount,
  ProductionDataDeliveryAttempt,
  ProductionDataInboundEvent,
  ProductionDataInspectorAdapter,
  ProductionDataOwnerSummary,
  ProductionDataOutboxMessage,
  ProductionDataSummary,
  ProductionDataToolCall
} from "@bob/operations-types/production-data"

import {
  ProductionDataInspector,
  ProductionDataInspectorError
} from "@bob/operations-types/production-data"
import { liftPromiseOperation } from "@bob/shared-types/effect-adapter"
import { sql } from "drizzle-orm"
import { Effect, Layer } from "effect"

export interface ProductionDataDatabase {
  execute(
    statement: Parameters<CoreDatabase["execute"]>[0],
    resultType: "objects"
  ): Effect.Effect<readonly object[], unknown>
}

interface CountRow {
  readonly key: string
  readonly count: number | string
}

interface OwnerSummaryRow {
  readonly ownerRef: string
  readonly messages: number | string
  readonly inboundMessages: number | string
  readonly outboundMessages: number | string
  readonly agentRuns: number | string
  readonly completedRuns: number | string
  readonly failedRuns: number | string
  readonly toolCalls: number | string
}

interface TotalRow {
  readonly total: number | string
}

interface InboundEventRow extends ProductionDataInboundEvent {}
interface AgentRunRow extends ProductionDataAgentRun {}
interface OutboxMessageRow extends ProductionDataOutboxMessage {}
interface DeliveryAttemptRow extends ProductionDataDeliveryAttempt {}
interface ToolCallRow extends ProductionDataToolCall {}

function countRows(rows: readonly CountRow[]): readonly ProductionDataCount[] {
  return rows.map((row) => ({ key: row.key, count: numberValue(row.count, "count") }))
}

function numberValue(value: number | string, label: string): number {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 0)
    throw new Error(`Invalid production data ${label}`)
  return parsed
}

async function query<Row>(
  database: ProductionDataDatabase,
  statement: Parameters<CoreDatabase["execute"]>[0]
) {
  const rows = await Effect.runPromise(database.execute(statement, "objects"))
  // SAFETY: Each caller supplies the selected columns and the matching row type.
  return rows as readonly Row[]
}

export function makeProductionDataInspector(
  database: ProductionDataDatabase
): ProductionDataInspectorAdapter {
  return {
    async summary(input) {
      const [
        totalMessages,
        totalOwners,
        totalAgentRuns,
        totalToolCalls,
        messageDirections,
        inboundStates,
        agentRunStates,
        deliveryStates,
        toolCallStates,
        owners
      ] = await Promise.all([
        query<TotalRow>(
          database,
          sql`SELECT COUNT(*)::int AS total FROM messages WHERE occurred_at >= ${input.from} AND occurred_at < ${input.to}`
        ),
        query<TotalRow>(
          database,
          sql`SELECT COUNT(DISTINCT user_id)::int AS total FROM messages WHERE occurred_at >= ${input.from} AND occurred_at < ${input.to}`
        ),
        query<TotalRow>(
          database,
          sql`SELECT COUNT(*)::int AS total FROM agent_runs WHERE created_at >= ${input.from} AND created_at < ${input.to}`
        ),
        query<TotalRow>(
          database,
          sql`SELECT COUNT(*)::int AS total FROM tool_calls WHERE created_at >= ${input.from} AND created_at < ${input.to}`
        ),
        query<CountRow>(
          database,
          sql`SELECT direction AS key, COUNT(*)::int AS count FROM messages WHERE occurred_at >= ${input.from} AND occurred_at < ${input.to} GROUP BY direction ORDER BY direction`
        ),
        query<CountRow>(
          database,
          sql`SELECT CASE WHEN dead_lettered_at IS NOT NULL THEN 'dead_lettered' WHEN processed_at IS NOT NULL THEN 'processed' WHEN claimed_at IS NOT NULL THEN 'claimed' WHEN enqueued_at IS NOT NULL THEN 'enqueued' ELSE 'accepted' END AS key, COUNT(*)::int AS count FROM inbound_events WHERE created_at >= ${input.from} AND created_at < ${input.to} GROUP BY key ORDER BY key`
        ),
        query<CountRow>(
          database,
          sql`SELECT status AS key, COUNT(*)::int AS count FROM agent_runs WHERE created_at >= ${input.from} AND created_at < ${input.to} GROUP BY status ORDER BY status`
        ),
        query<CountRow>(
          database,
          sql`SELECT state AS key, COUNT(*)::int AS count FROM delivery_attempts WHERE started_at >= ${input.from} AND started_at < ${input.to} GROUP BY state ORDER BY state`
        ),
        query<CountRow>(
          database,
          sql`SELECT status AS key, COUNT(*)::int AS count FROM tool_calls WHERE created_at >= ${input.from} AND created_at < ${input.to} GROUP BY status ORDER BY status`
        ),
        query<OwnerSummaryRow>(
          database,
          sql`WITH owner_messages AS (SELECT user_id, COUNT(*)::int AS messages, COUNT(*) FILTER (WHERE direction = 'inbound')::int AS "inboundMessages", COUNT(*) FILTER (WHERE direction = 'outbound')::int AS "outboundMessages" FROM messages WHERE occurred_at >= ${input.from} AND occurred_at < ${input.to} GROUP BY user_id), owner_runs AS (SELECT user_id, COUNT(*)::int AS "agentRuns", COUNT(*) FILTER (WHERE status = 'completed')::int AS "completedRuns", COUNT(*) FILTER (WHERE status = 'failed')::int AS "failedRuns" FROM agent_runs WHERE created_at >= ${input.from} AND created_at < ${input.to} GROUP BY user_id), owner_tools AS (SELECT owner_id, COUNT(*)::int AS "toolCalls" FROM tool_calls WHERE created_at >= ${input.from} AND created_at < ${input.to} GROUP BY owner_id) SELECT left(md5(owner_messages.user_id), 12) AS "ownerRef", owner_messages.messages, owner_messages."inboundMessages", owner_messages."outboundMessages", COALESCE(owner_runs."agentRuns", 0)::int AS "agentRuns", COALESCE(owner_runs."completedRuns", 0)::int AS "completedRuns", COALESCE(owner_runs."failedRuns", 0)::int AS "failedRuns", COALESCE(owner_tools."toolCalls", 0)::int AS "toolCalls" FROM owner_messages LEFT JOIN owner_runs ON owner_runs.user_id = owner_messages.user_id LEFT JOIN owner_tools ON owner_tools.owner_id = owner_messages.user_id ORDER BY owner_messages.messages DESC, "ownerRef" LIMIT ${input.limit}`
        )
      ])

      return {
        from: input.from,
        to: input.to,
        totalMessages: numberValue(totalMessages[0]?.total ?? 0, "total messages"),
        totalOwners: numberValue(totalOwners[0]?.total ?? 0, "total owners"),
        totalAgentRuns: numberValue(totalAgentRuns[0]?.total ?? 0, "total agent runs"),
        totalToolCalls: numberValue(totalToolCalls[0]?.total ?? 0, "total tool calls"),
        messageDirections: countRows(messageDirections),
        inboundEventStates: countRows(inboundStates),
        agentRunStates: countRows(agentRunStates),
        deliveryStates: countRows(deliveryStates),
        toolCallStates: countRows(toolCallStates),
        owners: owners.map((row): ProductionDataOwnerSummary => ({
          ownerRef: row.ownerRef,
          messages: numberValue(row.messages, "owner messages"),
          inboundMessages: numberValue(row.inboundMessages, "owner inbound messages"),
          outboundMessages: numberValue(row.outboundMessages, "owner outbound messages"),
          agentRuns: numberValue(row.agentRuns, "owner agent runs"),
          completedRuns: numberValue(row.completedRuns, "owner completed runs"),
          failedRuns: numberValue(row.failedRuns, "owner failed runs"),
          toolCalls: numberValue(row.toolCalls, "owner tool calls")
        }))
      } satisfies ProductionDataSummary
    },

    async workflow(correlationId, limit) {
      if (correlationId.trim().length === 0 || correlationId.length > 200) {
        throw new TypeError("Production data correlation ID is invalid")
      }
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
        throw new TypeError("Production data limit is invalid")
      }

      const [inboundEvents, agentRuns, outboxMessages, deliveryAttempts, toolCalls] =
        await Promise.all([
          query<InboundEventRow>(
            database,
            sql`SELECT id, message_id AS "messageId", correlation_id AS "correlationId", service, is_group AS "isGroup", attachment_count AS "attachmentCount", recovery_count AS "recoveryCount", enqueued_at AS "enqueuedAt", claimed_at AS "claimedAt", processed_at AS "processedAt", dead_lettered_at AS "deadLetteredAt", created_at AS "createdAt" FROM inbound_events WHERE correlation_id = ${correlationId} ORDER BY created_at, id LIMIT ${limit}`
          ),
          query<AgentRunRow>(
            database,
            sql`SELECT id, correlation_id AS "correlationId", origin_type AS "originType", status, model, execution_pool_id AS "executionPoolId", claimed_at AS "claimedAt", completed_at AS "completedAt", finalization_completed_at AS "finalizationCompletedAt", created_at AS "createdAt" FROM agent_runs WHERE correlation_id = ${correlationId} ORDER BY created_at, id LIMIT ${limit}`
          ),
          query<OutboxMessageRow>(
            database,
            sql`SELECT id, message_id AS "messageId", reason_code AS "reasonCode", correlation_id AS "correlationId", state, enqueued_at AS "enqueuedAt", claimed_at AS "claimedAt", dead_lettered_at AS "deadLetteredAt", completed_at AS "completedAt", created_at AS "createdAt" FROM outbox_messages WHERE correlation_id = ${correlationId} ORDER BY created_at, id LIMIT ${limit}`
          ),
          query<DeliveryAttemptRow>(
            database,
            sql`SELECT da.id, da.outbox_id AS "outboxId", da.attempt_number AS "attemptNumber", da.state, da.error_code AS "errorCode", da.started_at AS "startedAt", da.updated_at AS "updatedAt" FROM delivery_attempts da INNER JOIN outbox_messages om ON om.id = da.outbox_id WHERE om.correlation_id = ${correlationId} ORDER BY da.started_at, da.id LIMIT ${limit}`
          ),
          query<ToolCallRow>(
            database,
            sql`SELECT tc.id, tc.run_id AS "runId", tc.tool_name AS "toolName", tc.status, tc.attempt_number AS "attemptNumber", tc.claimed_at AS "claimedAt", tc.completed_at AS "completedAt", tc.created_at AS "createdAt" FROM tool_calls tc INNER JOIN agent_runs ar ON ar.id = tc.run_id WHERE ar.correlation_id = ${correlationId} ORDER BY tc.created_at, tc.id LIMIT ${limit}`
          )
        ])

      return {
        correlationId,
        inboundEvents,
        agentRuns,
        outboxMessages,
        deliveryAttempts,
        toolCalls
      }
    }
  }
}

export function productionDataInspectorLayer(adapter: ProductionDataInspectorAdapter) {
  const failure = (operation: keyof ProductionDataInspectorAdapter) => (cause: unknown) =>
    new ProductionDataInspectorError({ operation: String(operation), cause })
  return Layer.succeed(
    ProductionDataInspector,
    ProductionDataInspector.of({
      summary: liftPromiseOperation(adapter.summary, failure("summary")),
      workflow: liftPromiseOperation(adapter.workflow, failure("workflow"))
    })
  )
}
