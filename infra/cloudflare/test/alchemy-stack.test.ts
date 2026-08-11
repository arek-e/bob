import { readFile } from "node:fs/promises"
import { describe, expect, it } from "vitest"

describe("Alchemy compatibility stack", () => {
  it("evaluates the real Bob stack with injected state and providers", async () => {
    const smoke = await readFile(new URL("../alchemy.smoke.run.ts", import.meta.url), "utf8")

    expect(smoke).toContain("createBobStack")
    expect(smoke).toContain("inMemoryState")
    expect(smoke).toContain("smokeProviders")
    expect(smoke).not.toContain("compatible: true")
  })

  it("keeps production Worker logs and traces enabled", async () => {
    const stack = await readFile(new URL("../src/bob-stack.ts", import.meta.url), "utf8")

    expect(stack).not.toContain("traces: { enabled: false")
    expect(
      stack.match(/traces: \{ enabled: true, headSamplingRate: 1, persist: true \}/gu)
    ).toHaveLength(3)
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

  it("gives Sendblue egress a stable reconciliation domain", async () => {
    const stack = await readFile(new URL("../src/bob-stack.ts", import.meta.url), "utf8")

    expect(stack).toContain("const egressHost = `bob-sendblue-egress.${domain}`")
    expect(stack).toContain("SENDBLUE_EGRESS_URL: `https://${egressHost}`")
    expect(stack).toContain("domain: egressHost")
  })
})
