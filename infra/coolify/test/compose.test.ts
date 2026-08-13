import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

const repositoryRoot = new URL("../../../", import.meta.url)
const composeUrl = new URL("infra/coolify/compose.yaml", repositoryRoot)
const compose = readFileSync(composeUrl, "utf8")

describe("Coolify production stack", () => {
  it("has a valid Compose model", () => {
    expect(() =>
      execFileSync("docker", ["compose", "-f", composeUrl.pathname, "config", "--quiet"], {
        env: fixtureEnvironment(),
        stdio: "pipe"
      })
    ).not.toThrow()
  })

  it("pins every image and publishes no host ports", () => {
    const images = [...compose.matchAll(/^\s+image:\s+(.+)$/gm)].map((match) => match[1])
    expect(images).toHaveLength(7)
    expect(images.every((image) => image?.includes("@sha256:") || image?.includes("@${"))).toBe(
      true
    )
    expect(compose).not.toMatch(/^\s+ports:/m)
  })

  it("uses Coolify AppRole login and a persistent backup volume", () => {
    const model = JSON.parse(
      execFileSync("docker", ["compose", "-f", composeUrl.pathname, "config", "--format", "json"], {
        env: fixtureEnvironment(),
        encoding: "utf8"
      })
    ) as {
      services: {
        agent: { read_only?: boolean; volumes?: Array<{ target: string; read_only?: boolean }> }
        "agent-secret-init": { read_only?: boolean; secrets?: Array<{ target: string }> }
      }
    }

    expect(compose).toContain("BAO_AUTH_METHOD: approle")
    expect(compose).not.toContain("BAO_APPROLE_SECRET_ID: ${BAO_APPROLE_SECRET_ID:?}")
    expect(compose).toContain("BAO_APPROLE_SECRET_ID_PATH: /run/secrets/openbao_approle_secret_id")
    expect(compose).toContain("target: openbao_approle_secret_id")
    expect(compose).toContain("environment: BAO_APPROLE_SECRET_ID")
    expect(compose).toContain("NANGO_RECORDS_DATABASE_URL")
    expect(compose).toContain("external: true")
    expect(compose).toContain("bob-backups:/backups")
    expect(compose).toContain("Date.now()-newest>18000000")
    expect(model.services.agent.read_only).toBe(true)
    expect(model.services["agent-secret-init"].read_only).not.toBe(true)
    expect(model.services["agent-secret-init"].secrets).toContainEqual(
      expect.objectContaining({ target: "openbao_approle_secret_id" })
    )
    expect(model.services.agent.volumes).toContainEqual(
      expect.objectContaining({ target: "/run/secrets", read_only: true })
    )
  })

  it("exports content-free host, container, service, and backup metrics", () => {
    const model = JSON.parse(
      execFileSync("docker", ["compose", "-f", composeUrl.pathname, "config", "--format", "json"], {
        env: fixtureEnvironment(),
        encoding: "utf8"
      })
    ) as { services: { observer: { environment: { OTEL_CONFIG: string } } } }
    const collector = model.services.observer.environment.OTEL_CONFIG

    expect(compose).toContain("otel/opentelemetry-collector-contrib@sha256:")
    expect(compose).toContain("command: [--config=env:OTEL_CONFIG]")
    expect(compose).toContain("OTEL_CONFIG: *observer-config")
    expect(compose).not.toContain("otel-collector.yaml:/etc/otelcol-contrib/config.yaml")
    expect(compose).toContain("/:/hostfs:ro")
    expect(compose).toContain("/var/run/docker.sock:/var/run/docker.sock:ro")
    expect(compose).toContain("bob-backups:/backups:ro")
    expect(collector).toContain("host_metrics:")
    expect(collector).toContain("docker_stats:")
    expect(collector).toContain("http_check:")
    expect(collector).toContain("http://coolify:8080/api/health")
    expect(collector).toContain("https://bob-sendblue.tpops.dev/health")
    expect(collector).toContain("tcp_check:")
    expect(collector).toContain("file_stats/bob_backup:")
    expect(collector).toContain("file_stats/nango_backup:")
    expect(collector).toContain('set(attributes["backup_type"], "bob")')
    expect(collector).toContain('set(attributes["backup_type"], "nango")')
    expect(collector).toContain('endpoint: "fixture:5432"')
    expect(collector).toContain("endpoint: fixture")
    expect(collector).not.toContain("${env:")
    expect(collector).not.toContain("pipelines:\n    logs:")
  })
})

function fixtureEnvironment(): NodeJS.ProcessEnv {
  const required = [
    "ACCESS_TEAM_DOMAIN",
    "ADMIN_ACCESS_AUDIENCE",
    "ADMIN_ACCESS_SUBJECT",
    "BAO_ADDR",
    "BAO_APPROLE_ROLE_ID",
    "BAO_APPROLE_SECRET_ID",
    "BACKUP_AGE_RECIPIENT",
    "BACKUP_COPY_ACCESS_KEY_ID",
    "BACKUP_COPY_BUCKET",
    "BACKUP_COPY_ENDPOINT",
    "BACKUP_COPY_REGION",
    "BACKUP_COPY_SECRET_ACCESS_KEY",
    "BOB_ALLOWED_MODELS",
    "BOB_MODEL",
    "CLOUDFLARED_TUNNEL_TOKEN",
    "CLOUDFLARE_ACCOUNT_ID",
    "CLOUDFLARE_BACKUP_API_TOKEN",
    "CLOUDFLARE_D1_DATABASE_ID",
    "CORE_ACCESS_CLIENT_ID",
    "CORE_ACCESS_CLIENT_SECRET",
    "CORE_URL",
    "NANGO_ADMIN_KEY",
    "NANGO_DASHBOARD_PASSWORD",
    "NANGO_DASHBOARD_USERNAME",
    "NANGO_DB_PASSWORD",
    "NANGO_DB_HOST",
    "NANGO_ENCRYPTION_KEY",
    "NANGO_PUBLIC_CONNECT_URL",
    "NANGO_PUBLIC_SERVER_URL",
    "NANGO_RECORDS_DATABASE_URL",
    "NANGO_SECRET_KEY_DEV",
    "NANGO_SERVER_URL",
    "OTEL_EXPORTER_OTLP_ENDPOINT",
    "R2_BACKUP_ACCESS_KEY_ID",
    "R2_BACKUP_SECRET_ACCESS_KEY",
    "R2_BUCKET",
    "R2_ENDPOINT",
    "RUN_ACCESS_AUDIENCE",
    "RUN_ACCESS_SUBJECT"
  ]
  return {
    PATH: process.env.PATH,
    ...Object.fromEntries(required.map((key) => [key, "fixture"])),
    BOB_AGENT_IMAGE_DIGEST: `sha256:${"a".repeat(64)}`,
    BOB_BACKUP_IMAGE_DIGEST: `sha256:${"b".repeat(64)}`,
    BOB_RELEASE_SHA: "c".repeat(40)
  }
}
