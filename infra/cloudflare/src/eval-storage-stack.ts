import * as Alchemy from "alchemy"
import * as Cloudflare from "alchemy/Cloudflare"
import { retain } from "alchemy/RemovalPolicy"
import * as Effect from "effect/Effect"

export interface EvalStorageStackOptions {
  readonly name?: string
  readonly providers: ReturnType<typeof Cloudflare.providers>
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

      return {
        databaseId: database.databaseId,
        artifactBucketName: artifacts.bucketName
      }
    })
  )
}
