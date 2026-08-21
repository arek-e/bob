import type { AgentRunGatewayService } from "@bob/agent-runs-types/worker-gateway"
import type { JobProcessor } from "@bob/job-queue-types"

import { AgentRunJob } from "@bob/agent-runs-types/worker-gateway"
import { AgentCheckpointError, BobAgent } from "@bob/agent-types"
import { AgentRunResult } from "@bob/agent-types/run"
import { completeJob, retryJob } from "@bob/job-queue-types"
import { elapsedMilliseconds, withBobSpan, withTraceparent } from "@bob/observability"
import { Effect, Schema } from "effect"

import type { AgentComposition } from "./composition.ts"

import { withAgentExecutionContext } from "./execution-context.ts"

const LEASE_MS = 90_000
const CONTROL_POLL_MS = 2_000

export function makeAgentRunJobProcessor(input: {
  readonly composition: AgentComposition
  readonly gateway: AgentRunGatewayService
  readonly workerId: string
}): JobProcessor<typeof AgentRunJob.Type> {
  return {
    async process(job) {
      if (job.executionPoolId !== input.composition.config.executionPoolId) return completeJob
      const acquired = await Effect.runPromise(
        input.gateway.acquire({ job, workerId: input.workerId, leaseMs: LEASE_MS })
      )
      if (acquired.state === "not_eligible") {
        if (acquired.reason !== "already_claimed" && acquired.reason !== "retry_wait") {
          return completeJob
        }
        const delayMs =
          acquired.retryAt === undefined
            ? 5_000
            : Math.max(1_000, Date.parse(acquired.retryAt) - Date.now())
        return retryJob(Math.min(delayMs, LEASE_MS))
      }
      if (
        acquired.request.deploymentProfileId !== input.composition.profile.profileId ||
        acquired.request.capabilityCatalogueGeneration !== input.composition.profile.generation
      ) {
        const result = failedResult(acquired.request, input.composition.config.model, "policy", 0)
        await Effect.runPromise(
          input.gateway.recordOutcome({ authority: acquired.authority, result })
        )
        return completeJob
      }

      let authority = acquired.authority
      let checking = false
      let cancellationObserved = false
      const controller = new AbortController()
      const startedAt = Date.now()
      const controlTimer = setInterval(() => {
        if (checking || controller.signal.aborted) return
        checking = true
        void Effect.runPromise(input.gateway.readControl(authority))
          .then(async (control) => {
            if (control.cancellationRequested) {
              cancellationObserved = true
              controller.abort(new Error("agent_run_cancelled"))
              return
            }
            if (Date.parse(authority.leaseExpiresAt) - Date.now() <= LEASE_MS / 2) {
              authority = await Effect.runPromise(
                input.gateway.renew({ authority, leaseMs: LEASE_MS })
              )
            }
          })
          .catch(() => controller.abort(new Error("agent_run_authority_lost")))
          .finally(() => {
            checking = false
          })
      }, CONTROL_POLL_MS)

      let result: typeof AgentRunResult.Type
      try {
        const durability = {
          operations: acquired.checkpoints,
          append: (operation: (typeof acquired.checkpoints)[number]) =>
            input.gateway.appendCheckpoint({ authority, operation }).pipe(
              Effect.mapError(
                (cause) =>
                  new AgentCheckpointError({
                    message: "Agent checkpoint append failed",
                    cause
                  })
              )
            )
        }
        const runSpan: Parameters<typeof withBobSpan>[0] = {
          name: "bob.agent.run",
          correlationId: acquired.request.correlationId,
          runId: acquired.request.runId,
          feature: "assistant"
        }
        if (job.enqueuedAt !== undefined) {
          const queueWaitMs = elapsedMilliseconds(job.enqueuedAt)
          if (queueWaitMs !== undefined) Object.assign(runSpan, { queueWaitMs })
        }
        const execution = withTraceparent(
          withBobSpan(
            runSpan,
            BobAgent.use((agent) => agent.runTurn(acquired.request, durability))
          ),
          job.traceparent
        )
        result = Schema.decodeUnknownSync(AgentRunResult)(
          await withAgentExecutionContext(
            { ownerId: acquired.request.ownerId, authority: () => authority },
            () => input.composition.runtime.runPromise(execution, { signal: controller.signal })
          )
        )
      } catch {
        if (!cancellationObserved) {
          try {
            const control = await Effect.runPromise(input.gateway.readControl(authority))
            cancellationObserved = control.cancellationRequested
          } catch {
            // A stale or expired authority is handled when the queue retries the pointer job.
          }
        }
        result = cancellationObserved
          ? cancelledResult(
              acquired.request,
              input.composition.config.model,
              Date.now() - startedAt
            )
          : failedResult(
              acquired.request,
              input.composition.config.model,
              "provider",
              Date.now() - startedAt
            )
      } finally {
        clearInterval(controlTimer)
      }

      await Effect.runPromise(input.gateway.recordOutcome({ authority, result }))
      return completeJob
    }
  }
}

function failedResult(
  request: Parameters<typeof cancelledResult>[0],
  model: string,
  errorCode: "provider" | "policy",
  durationMs: number
) {
  return Schema.decodeUnknownSync(AgentRunResult)({
    protocolVersion: 1,
    runId: request.runId,
    correlationId: request.correlationId,
    status: "failed",
    errorCode,
    model,
    durationMs: Math.max(0, durationMs),
    inputTokens: 0,
    outputTokens: 0,
    toolCalls: 0
  })
}

function cancelledResult(
  request: { readonly runId: string; readonly correlationId: string },
  model: string,
  durationMs: number
) {
  return Schema.decodeUnknownSync(AgentRunResult)({
    protocolVersion: 1,
    runId: request.runId,
    correlationId: request.correlationId,
    status: "cancelled",
    errorCode: "cancelled",
    model,
    durationMs: Math.max(0, durationMs),
    inputTokens: 0,
    outputTokens: 0,
    toolCalls: 0
  })
}
