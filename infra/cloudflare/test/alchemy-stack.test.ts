import * as Alchemy from "alchemy"
import { Stage } from "alchemy/Stage"
import * as AlchemyTest from "alchemy/Test/Core"
import * as Effect from "effect/Effect"
import { spawnSync } from "node:child_process"
import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

import offlineStack from "../alchemy.smoke.run.ts"
import { smokeProviders } from "../src/smoke-providers.ts"

async function offlinePlan() {
  const compiled = await AlchemyTest.run(offlineStack.pipe(Effect.provideService(Stage, "prod")), {
    providers: smokeProviders(),
    state: Alchemy.inMemoryState(),
    stage: "prod",
    dev: false,
    sidecar: false
  })

  return Effect.runPromise(Alchemy.Plan.make(compiled).pipe(Effect.provide(compiled.services)))
}

describe("Alchemy compatibility stack", () => {
  it("evaluates the real Bob stack with injected state and providers", async () => {
    const smoke = await readFile(new URL("../alchemy.smoke.run.ts", import.meta.url), "utf8")

    expect(smoke).toContain("createBobStack")
    expect(smoke).toContain("inMemoryState")
    expect(smoke).toContain("smokeProviders")
    expect(smoke).not.toContain("compatible: true")
  })

  it("plans the exact production OTLP edge and all Worker bindings offline", () => {
    const result = spawnSync("pnpm", ["run", "load:check"], {
      cwd: fileURLToPath(new URL("../", import.meta.url)),
      encoding: "utf8"
    })

    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain("Plan: 40 to create")
    for (const resource of [
      "[BackupArchives] create",
      "[NangoBackups] create",
      "[WorkerToOtlp] create",
      "[WorkerOtlpServicePolicy] create",
      "[WorkerOtlpApplication] create",
      "[OtlpTunnelDns] create",
      "[CoreWorker/OTEL_EXPORTER_OTLP_ENDPOINT] create",
      "[CoreWorker/OTEL_ACCESS_CLIENT_ID] create",
      "[CoreWorker/OTEL_ACCESS_CLIENT_SECRET] create",
      "[CoreWorker/BOB_RELEASE_SHA] create",
      "[SendblueIngress/OTEL_EXPORTER_OTLP_ENDPOINT] create",
      "[SendblueIngress/OTEL_ACCESS_CLIENT_ID] create",
      "[SendblueIngress/OTEL_ACCESS_CLIENT_SECRET] create",
      "[SendblueIngress/BOB_RELEASE_SHA] create",
      "[SendblueEgress/OTEL_EXPORTER_OTLP_ENDPOINT] create",
      "[SendblueEgress/OTEL_ACCESS_CLIENT_ID] create",
      "[SendblueEgress/OTEL_ACCESS_CLIENT_SECRET] create",
      "[SendblueEgress/BOB_RELEASE_SHA] create"
    ]) {
      expect(result.stdout).toContain(resource)
    }
  }, 30_000)

  it("declares separate R2 buckets for Bob and Nango backups", async () => {
    const stack = await readFile(new URL("../src/bob-stack.ts", import.meta.url), "utf8")

    expect(stack).toContain('Cloudflare.R2.Bucket("BackupArchives"')
    expect(stack).toContain("name: `bob-backup-${PRODUCTION_STAGE}`")
    expect(stack).toContain('Cloudflare.R2.Bucket("NangoBackups"')
    expect(stack).toContain("name: `bob-nango-backup-${PRODUCTION_STAGE}`")
    expect(stack.match(/expire-backups-after-180-days/gu)).toHaveLength(2)
    expect(stack.match(/maxAge: 15_552_000/gu)).toHaveLength(2)
  })

  it("plans evaluation storage as an isolated stack", () => {
    const result = spawnSync("pnpm", ["run", "evals:load"], {
      cwd: fileURLToPath(new URL("../", import.meta.url)),
      encoding: "utf8"
    })

    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain("Plan: 3 to create")
    expect(result.stdout).toContain("[EvalDatabase] create")
    expect(result.stdout).toContain("[EvalArtifacts] create")
    expect(result.stdout).toContain("[EvalRunner] create")
    expect(result.stdout).not.toContain("[CoreWorker]")
    expect(result.stdout).not.toContain("[Database]")
  }, 30_000)

  it("isolates evaluation records and artifacts from production Workers", async () => {
    const [stack, evalStack] = await Promise.all([
      readFile(new URL("../src/bob-stack.ts", import.meta.url), "utf8"),
      readFile(new URL("../src/eval-storage-stack.ts", import.meta.url), "utf8")
    ])

    expect(evalStack).toContain('Cloudflare.D1.Database("EvalDatabase"')
    expect(evalStack).toContain('name: "bob-evals-prod"')
    expect(evalStack).toContain('migrationsDir: "../../tools/agent-evals/migrations"')
    expect(evalStack).toContain('Cloudflare.R2.Bucket("EvalArtifacts"')
    expect(evalStack).toContain('name: "bob-eval-artifacts-prod"')
    expect(evalStack).toContain('Cloudflare.Worker("EvalRunner"')
    expect(evalStack).toContain('name: "bob-eval-runner-prod"')
    expect(evalStack).toContain('main: "../../apps/eval-worker/src/index.ts"')
    expect(evalStack).toContain('crons: ["45 22 * * *"]')
    expect(evalStack).toContain("EVAL_DB: database")
    expect(evalStack).toContain("EVAL_ARTIFACTS: artifacts")
    expect(evalStack).toContain("BOB_RELEASE_SHA: options.releaseSha")
    expect(evalStack).toContain("workersDev: false")
    expect(evalStack).not.toContain("OWNER_ID")
    expect(evalStack).not.toContain("PRIVATE_OBJECTS")
    expect(stack).not.toContain("EvalDatabase")
    expect(stack).not.toContain("EvalArtifacts")

    const coreWorkerEnvironment = stack.slice(
      stack.indexOf("const coreWorker ="),
      stack.indexOf("let ingressUrl")
    )
    expect(coreWorkerEnvironment).not.toContain("EVAL_DB")
    expect(coreWorkerEnvironment).not.toContain("EVAL_ARTIFACTS")
  })

  it("keeps production Worker logs and traces enabled", async () => {
    const stack = await readFile(new URL("../src/bob-stack.ts", import.meta.url), "utf8")

    expect(stack).not.toContain("traces: { enabled: false")
    expect(
      stack.match(/traces: \{ enabled: true, headSamplingRate: 1, persist: true \}/gu)
    ).toHaveLength(3)
  })

  it("uses one dedicated Access path for Worker OTLP", async () => {
    const stack = await readFile(new URL("../src/bob-stack.ts", import.meta.url), "utf8")
    expect(stack).toContain("const otlpHost = `bob-otel.${domain}`")
    expect(stack).toContain('Cloudflare.Access.ServiceToken("WorkerToOtlp"')
    expect(stack).toContain('"WorkerOtlpServicePolicy"')
    expect(stack).toContain("tokenId: workerToOtlp.serviceTokenId")
    expect(stack).toContain('"WorkerOtlpApplication"')
    expect(stack).toContain("domain: otlpHost")
    expect(stack).toContain("{ hostname: otlpHost, service: ENV.OTEL_ORIGIN_URL }")
    expect(stack).toContain("{ hostname: nangoHost, service: ENV.NANGO_ORIGIN_URL }")
    expect(stack).toContain("{ hostname: nangoConnectHost, service: ENV.NANGO_CONNECT_ORIGIN_URL }")

    const otlpDns = stack.slice(
      stack.indexOf('Cloudflare.DNS.Record("OtlpTunnelDns"'),
      stack.indexOf('Cloudflare.DNS.Record("NangoTunnelDns"')
    )
    expect(otlpDns).toContain("name: otlpHost")
    expect(otlpDns).toContain('type: "CNAME"')
    expect(otlpDns).toContain(
      "content: Output.interpolate`${agentTunnel.tunnelId}.cfargotunnel.com`"
    )
    expect(otlpDns).toContain("proxied: true")

    const otlpIngress = stack.indexOf("hostname: otlpHost")
    const catchAll = stack.indexOf('{ service: "http_status:404" }')
    expect(otlpIngress).toBeGreaterThan(-1)
    expect(otlpIngress).toBeLessThan(catchAll)

    const handoff = stack.slice(
      stack.indexOf("yield* RuntimeCredentialHandoff"),
      stack.indexOf("return {", stack.indexOf("yield* RuntimeCredentialHandoff"))
    )
    expect(handoff).not.toContain("workerToOtlp")

    for (const binding of [
      "BOB_RELEASE_SHA: ENV.BOB_RELEASE_SHA",
      "OTEL_EXPORTER_OTLP_ENDPOINT: `https://${otlpHost}`",
      "OTEL_ACCESS_CLIENT_ID: Output.map(workerToOtlp.clientId, Redacted.make)",
      "OTEL_ACCESS_CLIENT_SECRET: Output.map(workerToOtlp.clientSecret"
    ]) {
      expect(
        stack.match(new RegExp(binding.replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "gu"))
      ).toHaveLength(3)
    }
  })

  it("does not keep migration canary resources in the steady-state stack", async () => {
    const stack = await readFile(new URL("../src/bob-stack.ts", import.meta.url), "utf8")

    expect(stack).not.toContain("Canary")
    expect(stack).not.toContain("canary")
  })

  it("keeps the stable Core host and limits Access to internal and setup paths", async () => {
    const stack = await readFile(new URL("../src/bob-stack.ts", import.meta.url), "utf8")

    expect(stack).toContain("const coreWorkerName = ENV.CLOUDFLARE_CORE_WORKER_NAME")
    expect(stack).toContain("const coreHost = `bob.${domain}`")
    expect(stack).toContain("domain: `${coreHost}/internal`")
    expect(stack).toContain("domain: `${coreHost}/setup`")
    expect(stack).toContain('flags: ["nodejs_compat"]')
    expect(stack).toContain("name: coreWorkerName")
    expect(stack).toContain("workersDev: false")
    expect(stack).toContain("domain: coreHost")
    expect(stack).toContain("coreUrl: `https://${coreHost}`")
  })

  it("deploys Sendblue ingress before egress can emit a new callback format", async () => {
    const plan = await offlinePlan()

    expect(plan.resources.SendblueIngress.downstream).toContain("SendblueEgress")
  }, 30_000)
})
