import { readFile } from "node:fs/promises"

const source = await readFile(new URL("../infra/compose/compose.yaml", import.meta.url), "utf8")
for (const service of ["application-storage", "job-queue", "core", "agent", "channel"]) {
  if (!source.includes(`  ${service}:\n`)) throw new Error(`Portable runtime is missing ${service}`)
}
for (const providerService of ["postgres", "redis"]) {
  if (source.includes(`  ${providerService}:\n`)) {
    throw new Error(`Portable runtime uses provider name as a service key: ${providerService}`)
  }
}
for (const marker of [
  "APPLICATION_STORAGE_URL",
  "JOB_QUEUE_URL",
  "OBJECT_STORAGE_DIRECTORY",
  "CHANNEL_EGRESS_URL",
  "SCHEDULER_INTERVAL_MS",
  "object-storage-data:",
  "application-storage-data:",
  "job-queue-data:",
  "condition: service_healthy"
]) {
  if (!source.includes(marker)) throw new Error(`Portable runtime is missing ${marker}`)
}
if (/image:\s+[^\s@]+:(?:latest|main)(?:\s|$)/u.test(source)) {
  throw new Error("Portable runtime uses a mutable image tag")
}
console.log("Portable runtime deployment contract is valid.")
