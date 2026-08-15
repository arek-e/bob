const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/u

function parseJson(value, label) {
  try {
    return JSON.parse(value)
  } catch {
    throw new Error(`${label} must contain valid JSON`)
  }
}

function requireText(value, marker, message) {
  if (!value.includes(marker)) throw new Error(message)
}

export function assertDeploymentReadiness(input) {
  const baseImages = parseJson(input.baseImages, "The Coolify base image manifest")
  const runtime = parseJson(input.runtimeContract, "The Coolify runtime contract")
  const compose = input.coolifyCompose
  const agentPolicy = input.agentPolicy

  if (
    baseImages.schemaVersion !== 1 ||
    !DIGEST_PATTERN.test(baseImages.cloudflaredDigest) ||
    !DIGEST_PATTERN.test(baseImages.observerDigest)
  ) {
    throw new Error("The Runtime base images need immutable digests")
  }
  if (runtime.schemaVersion !== 1) throw new Error("The runtime contract version is unsupported")
  if (
    runtime.backup?.service !== "backup-runner" ||
    runtime.backup?.schedule !== "15 */4 * * *" ||
    runtime.backup?.targetRpoSeconds !== 14_400 ||
    runtime.backup?.maximumAgeSeconds > 18_000 ||
    runtime.backup?.failureNotificationsRequired !== true
  ) {
    throw new Error("The Coolify backup schedule does not meet the four-hour RPO")
  }
  requireText(
    runtime.backup.command ?? "",
    "dist/index.mjs backup",
    "The Coolify backup command is incomplete"
  )
  if (
    runtime.readiness?.service !== "agent" ||
    runtime.readiness?.path !== "/v1/admin/readiness" ||
    runtime.readiness?.accessScope !== "admin"
  ) {
    throw new Error("The private agent readiness contract is incomplete")
  }
  if (
    !Array.isArray(runtime.residualFailureDomains) ||
    runtime.residualFailureDomains.length !== 2
  ) {
    throw new Error("The runtime contract must state both accepted failure domains")
  }

  for (const marker of [
    "ghcr.io/arek-e/bob-agent@${BOB_AGENT_IMAGE_DIGEST:?}",
    "ghcr.io/arek-e/bob-data-backup@${BOB_BACKUP_IMAGE_DIGEST:?}",
    "docker.io/cloudflare/cloudflared@${CLOUDFLARED_IMAGE_DIGEST:?}",
    "docker.io/otel/opentelemetry-collector-contrib@${BOB_OBSERVER_IMAGE_DIGEST:?}",
    "BAO_APPROLE_SECRET_ID_PATH: /run/secrets/openbao_approle_secret_id",
    "target: openbao_approle_secret_id",
    "environment: BAO_APPROLE_SECRET_ID",
    "bob-backups:/backups",
    "file_stats/bob_backup:"
  ]) {
    requireText(compose, marker, `The Coolify Compose contract is missing ${marker}`)
  }
  if (compose.includes("BAO_APPROLE_SECRET_ID: ${BAO_APPROLE_SECRET_ID:?}")) {
    throw new Error("The agent must receive the AppRole secret ID through a secret file")
  }
  if (/^\s+ports:/mu.test(compose))
    throw new Error("The private runtime must not publish host ports")
  const images = [...compose.matchAll(/^\s+image:\s+(.+)$/gmu)].map((match) => match[1])
  if (
    images.length === 0 ||
    images.some((image) => !image.includes("@sha256:") && !image.includes("@${"))
  ) {
    throw new Error("Every Coolify image must use an immutable digest")
  }

  requireText(
    agentPolicy,
    'path "ops/data/apps/prod/bob/pi-auth/openai-codex"',
    "The agent policy needs the Pi credential path"
  )
  if (agentPolicy.includes("backup") || agentPolicy.includes("nango")) {
    throw new Error("The agent OpenBao policy grants unrelated access")
  }

  return { baseImages, runtime }
}
