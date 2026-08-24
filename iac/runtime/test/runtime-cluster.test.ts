import { readFile } from "node:fs/promises"
import { describe, expect, it } from "vitest"

describe("production Runtime Compose contract", () => {
  it("mounts the Agent Worker OpenBao identity at its configured container path", async () => {
    const compose = await readFile(
      new URL("../../../deployment/runtime-cluster.compose.yaml", import.meta.url),
      "utf8"
    )
    const worker = compose.slice(compose.indexOf("  agent-worker:"), compose.indexOf("  channel:"))

    expect(worker).toContain(
      "BAO_APPROLE_SECRET_ID_PATH: /run/secrets/openbao_agent_approle_secret_id"
    )
    expect(worker).toContain("BAO_ADDR: https://bob-openbao-proxy:8443")
    expect(worker).toContain("NODE_EXTRA_CA_CERTS: /etc/bob-openbao/ca.pem")
    expect(worker).toContain("networks: [runtime, egress, openbao]")
    expect(worker).toContain("${OPENBAO_CA_FILE:?}:/etc/bob-openbao/ca.pem:ro")
    expect(worker).toContain("secrets: [openbao_agent_approle_secret_id]")
    expect(compose).toContain("file: ${BAO_APPROLE_SECRET_ID_PATH:?}")
    expect(compose).toContain("name: bob-runtime-openbao")
  })

  it("defines maintenance as a target-cluster one-shot job", async () => {
    const compose = await readFile(
      new URL("../../../deployment/runtime-cluster.compose.yaml", import.meta.url),
      "utf8"
    )
    const coreDockerfile = await readFile(
      new URL("../../../apps/core/Dockerfile", import.meta.url),
      "utf8"
    )
    const corePackage = await readFile(
      new URL("../../../apps/core/package.json", import.meta.url),
      "utf8"
    )
    const maintenance = compose.slice(compose.indexOf("  maintenance:"), compose.indexOf("  core:"))

    expect(maintenance).toContain("image: ${CORE_IMAGE_REFERENCE:?")
    expect(maintenance).toContain("BOB_MAINTENANCE_IMAGE_DIGEST: ${CORE_IMAGE_DIGEST:?")
    expect(maintenance).not.toContain("BOB_MAINTENANCE_IMAGE_REFERENCE")
    expect(maintenance).toContain("entrypoint: [node, /app/dist/maintenance-entrypoint.mjs]")
    expect(maintenance).not.toContain("bob-maintenance")
    expect(corePackage).toContain("dist/maintenance.mjs")
    expect(coreDockerfile).toContain("node_modules/varlock")
    expect(maintenance).toContain('restart: "no"')
    expect(maintenance).toContain("profiles: [operations]")
    expect(maintenance).toContain("BOB_MAINTENANCE_MODE: cluster-job")
    expect(maintenance).toContain("BOB_MAINTENANCE_CLUSTER_ID: ${BOB_MAINTENANCE_CLUSTER_ID:?")
    expect(maintenance).toContain("BOB_MAINTENANCE_RELEASE_ID: ${BOB_MAINTENANCE_RELEASE_ID:?")
    expect(maintenance).toContain("BOB_MIGRATIONS_FOLDER: /app/dist/migrations")
    expect(maintenance).toContain("depends_on:")
    expect(maintenance).toContain("postgresql: { condition: service_healthy }")
    expect(maintenance).toContain("networks: [runtime, openbao]")
  })
})
