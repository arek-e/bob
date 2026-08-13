import { readFile } from "node:fs/promises"

const composePath = "infra/coolify/compose.yaml"
const requiredServices = ["agent", "cloudflared", "nango", "redis", "backup-runner"]
const digestImage = /image:\s+[^\s@]+@\$\{[A-Z0-9_]+(?::\?[^}]+)?\}/u

export function assertCoolifyComposeReadiness(source) {
  if (typeof source !== "string" || source.trim().length === 0) {
    throw new Error("Coolify Compose contract is empty")
  }
  if (!source.startsWith("services:\n")) throw new Error("Coolify Compose must define services")
  if (/^\s+ports:/mu.test(source)) throw new Error("Coolify Compose must not publish host ports")
  if (/:latest(?:\s|$)/mu.test(source)) throw new Error("Coolify Compose must not use latest tags")
  for (const service of requiredServices) {
    const section = source.match(
      new RegExp(`^  ${service}:\\n([\\s\\S]*?)(?=^  [a-z0-9-]+:\\n|^volumes:\\n|$)`, "mu")
    )?.[1]
    if (section === undefined) throw new Error(`Coolify Compose is missing ${service}`)
    if (!digestImage.test(section)) throw new Error(`${service} must use an immutable image digest`)
  }
  for (const marker of [
    "BOB_RELEASE_SHA",
    "CLOUDFLARED_TUNNEL_TOKEN",
    "NANGO_RECORDS_DATABASE_URL",
    "BACKUP_OUTPUT_DIRECTORY",
    "bob-backups:"
  ]) {
    if (!source.includes(marker)) throw new Error(`Coolify Compose is missing ${marker}`)
  }
  for (const forbidden of ["Kubernetes", "Argo", "tpops.dev", "lamb-bicolor", "cluster.local"]) {
    if (source.includes(forbidden))
      throw new Error(`Coolify Compose contains private legacy text: ${forbidden}`)
  }
  return { services: requiredServices.length }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const source = await readFile(composePath, "utf8")
  assertCoolifyComposeReadiness(source)
  console.log("Coolify Compose contract is ready.")
}
