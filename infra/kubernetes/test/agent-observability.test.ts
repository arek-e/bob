import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const repositoryRoot = new URL("../../../", import.meta.url)
const collectorEndpoint =
  "http://prod-otel-collector-opentelemetry-collector.monitoring.svc.cluster.local:4318"
const releaseSha = "f974ae0fc5b53ca1c233faa0dfd69e9f814cb25f"

function renderProduction(): string {
  const result = spawnSync("kubectl", ["kustomize", "infra/kubernetes"], {
    cwd: fileURLToPath(repositoryRoot),
    encoding: "utf8"
  })
  if (result.status !== 0) throw new Error(result.stderr)
  return result.stdout
}

describe("agent production observability contract", () => {
  it("configures OTLP and permits only the monitoring collector on port 4318", () => {
    const rendered = renderProduction()

    expect(rendered).toContain(`BOB_RELEASE_SHA: ${releaseSha}`)
    expect(rendered).toContain(`OTEL_EXPORTER_OTLP_ENDPOINT: ${collectorEndpoint}`)
    expect(rendered).toContain("kubernetes.io/metadata.name: monitoring")
    expect(rendered).toContain("app.kubernetes.io/instance: prod-otel-collector")
    expect(rendered).toContain("app.kubernetes.io/name: opentelemetry-collector")
    expect(rendered).toContain("component: standalone-collector")
    expect(rendered.match(/port: ["']?4318["']?/gu)).toHaveLength(2)
  })
})
