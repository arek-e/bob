import type { EvalWorkerBindings } from "./bindings.ts"

import { evaluateCommittedInteractionSuite } from "./evaluation.ts"
import { failEvaluationRun, recordEvaluationRun } from "./storage.ts"

const safeFailureCodes = new Set([
  "evaluation_artifact_conflict",
  "evaluation_completed_run_incomplete",
  "evaluation_gate_failed",
  "evaluation_release_sha_invalid",
  "evaluation_scheduled_time_invalid",
  "invalid_candidate_set",
  "invalid_evaluation_suite"
])

function safeFailureCode(error: unknown): string {
  if (error instanceof Error && safeFailureCodes.has(error.message)) return error.message
  return "evaluation_runtime_failed"
}

async function handleScheduled(
  controller: ScheduledController,
  bindings: EvalWorkerBindings
): Promise<void> {
  try {
    const evaluation = evaluateCommittedInteractionSuite()
    const result = await recordEvaluationRun({
      bindings,
      releaseSha: bindings.BOB_RELEASE_SHA,
      report: evaluation.report,
      sampleCount: evaluation.sampleCount,
      scheduledTime: controller.scheduledTime
    })
    console.log(
      JSON.stringify({
        event: "evaluation_run_completed",
        runId: result.runId,
        suiteId: evaluation.report.suiteId,
        passed: result.passed,
        duplicate: result.duplicate,
        caseCount: evaluation.report.cases.total
      })
    )
    if (!result.passed) {
      controller.noRetry()
      throw new Error("evaluation_gate_failed")
    }
  } catch (error) {
    const failureCode = safeFailureCode(error)
    if (failureCode !== "evaluation_gate_failed") {
      await failEvaluationRun(bindings, controller.scheduledTime, failureCode)
    }
    console.error(
      JSON.stringify({
        event: "evaluation_run_failed",
        runId: `scheduled-${controller.scheduledTime}`,
        failureCode
      })
    )
    throw error
  }
}

export default {
  scheduled(
    controller: ScheduledController,
    bindings: EvalWorkerBindings,
    _context: ExecutionContext
  ): Promise<void> {
    return handleScheduled(controller, bindings)
  }
} satisfies ExportedHandler<EvalWorkerBindings>
