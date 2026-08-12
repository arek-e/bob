export interface EvalWorkerBindings {
  readonly EVAL_DB: D1Database
  readonly EVAL_ARTIFACTS: R2Bucket
  readonly BOB_RELEASE_SHA: string
}
