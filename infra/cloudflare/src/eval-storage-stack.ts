import * as Alchemy from "alchemy"
import * as Cloudflare from "alchemy/Cloudflare"
import { retain } from "alchemy/RemovalPolicy"
import * as Effect from "effect/Effect"

export interface EvalStorageStackOptions {
  readonly name?: string
  readonly providers: ReturnType<typeof Cloudflare.providers>
  readonly releaseSha: string
  readonly state: ReturnType<typeof Cloudflare.state> | ReturnType<typeof Alchemy.inMemoryState>
}

export function createEvalStorageStack(options: EvalStorageStackOptions) {
  return Alchemy.Stack(
    options.name ?? "bob-evals",
    { providers: options.providers, state: options.state },
    Effect.gen(function* () {
      const database = yield* Cloudflare.D1.Database("EvalDatabase", {
        name: "bob-evals-prod",
        jurisdiction: "eu",
        primaryLocationHint: "weur",
        migrationsDir: "../../tools/agent-evals/migrations"
      }).pipe(retain(true))

      const artifacts = yield* Cloudflare.R2.Bucket("EvalArtifacts", {
        name: "bob-eval-artifacts-prod",
        jurisdiction: "eu",
        locationHint: "weur"
      }).pipe(retain(true))

      yield* Cloudflare.Worker("EvalRunner", {
        name: "bob-eval-runner-prod",
        main: "../../apps/eval-worker/src/index.ts",
        workersDev: false,
        compatibility: { date: "2026-08-10" },
        crons: ["45 22 * * *"],
        observability: {
          enabled: true,
          logs: { enabled: true, invocationLogs: true },
          traces: { enabled: true, headSamplingRate: 1, persist: true }
        },
        env: {
          EVAL_DB: database,
          EVAL_ARTIFACTS: artifacts,
          BOB_RELEASE_SHA: options.releaseSha
        }
      })

      return {
        databaseId: database.databaseId,
        artifactBucketName: artifacts.bucketName
      }
    })
  )
}
