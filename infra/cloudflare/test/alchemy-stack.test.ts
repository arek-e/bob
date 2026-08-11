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
    expect(result.stdout).toContain("Plan: 38 to create")
    for (const resource of [
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

  it("keeps production Worker logs and traces enabled", async () => {
    const stack = await readFile(new URL("../src/bob-stack.ts", import.meta.url), "utf8")

    expect(stack).not.toContain("traces: { enabled: false")
    expect(
      stack.match(/traces: \{ enabled: true, headSamplingRate: 1, persist: true \}/gu)
    ).toHaveLength(3)
  })

  it("uses one dedicated Access path for Worker OTLP", async () => {
    const stack = await readFile(new URL("../src/bob-stack.ts", import.meta.url), "utf8")
    const collectorEndpoint =
      "http://prod-otel-collector-opentelemetry-collector.monitoring.svc.cluster.local:4318"

    expect(stack).toContain("const otlpHost = `bob-otel.${domain}`")
    expect(stack).toContain('Cloudflare.Access.ServiceToken("WorkerToOtlp"')
    expect(stack).toContain('"WorkerOtlpServicePolicy"')
    expect(stack).toContain("tokenId: workerToOtlp.serviceTokenId")
    expect(stack).toContain('"WorkerOtlpApplication"')
    expect(stack).toContain("domain: otlpHost")
    expect(stack).toContain(`service:\n              "${collectorEndpoint}"`)

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
