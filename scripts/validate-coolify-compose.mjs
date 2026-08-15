import { readFile } from "node:fs/promises"

const composePath = new URL("../infra/coolify/compose.yaml", import.meta.url)
const requiredServices = [
  "agent-secret-init",
  "agent",
  "tunnel",
  "backup-runner",
  "observer"
]
const immutableImage = /image:\s+[^\s@]+@(?:sha256:[a-f0-9]{64}|\$\{[A-Z0-9_]+(?::\?[^}]*)?\})/u

function serviceSection(source, service) {
  return source.match(
    new RegExp(
      `^  ${service}:\\n([\\s\\S]*?)(?=^  [a-z0-9-]+:\\n|^networks:\\n|^volumes:\\n)`,
      "mu"
    )
  )?.[1]
}

export function assertCoolifyComposeReadiness(source) {
  if (typeof source !== "string" || source.trim().length === 0) {
    throw new Error("Coolify Compose contract is empty")
  }
  if (!/^services:\n/mu.test(source)) {
    throw new Error("Coolify Compose must define services")
  }
  if (/^\s+ports:/mu.test(source)) {
    throw new Error("Coolify Compose must not publish host ports")
  }
  if (/:latest(?:\s|$)/mu.test(source)) {
    throw new Error("Coolify Compose must not use latest tags")
  }

  for (const service of requiredServices) {
    const section = serviceSection(source, service)
    if (section === undefined) {
      throw new Error(`Coolify Compose is missing ${service}`)
    }
    if (!immutableImage.test(section)) {
      throw new Error(`${service} must use an immutable image digest`)
    }
  }

  for (const marker of [
    "BOB_RELEASE_SHA",
    "CLOUDFLARED_TUNNEL_TOKEN",
    "BACKUP_OUTPUT_DIRECTORY",
    "bob-backups:"
  ]) {
    if (!source.includes(marker)) {
      throw new Error(`Coolify Compose is missing ${marker}`)
    }
  }

  for (const forbidden of ["Kubernetes", "Argo", "cluster.local", "lamb-bicolor.ts.net"]) {
    if (source.includes(forbidden)) {
      throw new Error(`Coolify Compose contains private legacy text: ${forbidden}`)
    }
  }

  return { services: requiredServices.length }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const source = await readFile(composePath, "utf8")
  assertCoolifyComposeReadiness(source)
  console.log("Coolify Compose contract is ready.")
}
