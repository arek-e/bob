import { createHash } from "node:crypto"
import { readFile, writeFile } from "node:fs/promises"

const DIGEST = /^sha256:[0-9a-f]{64}$/u
const SHA = /^[0-9a-f]{40}$/u
const IMAGE_NAME = /^[a-z][a-z0-9-]+$/u
const IMAGE_REPOSITORY = /^(?:[a-z0-9.-]+\/)+[a-z0-9._/-]+$/u
const REQUIRED_IMAGES = ["agent-worker", "backup", "channel", "core", "migration"]

const object = (value) => Object.prototype.toString.call(value) === "[object Object]"
const canonical = (value) => {
  if (Array.isArray(value)) return value.map(canonical)
  if (!object(value)) return value
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonical(item)])
  )
}

export const canonicalJson = (value) => `${JSON.stringify(canonical(value))}\n`
export const contentDigest = (value) =>
  `sha256:${createHash("sha256").update(canonicalJson(value).trimEnd()).digest("hex")}`

export function assertReleaseBundle(bundle) {
  if (!object(bundle) || bundle.schemaVersion !== "bob.runtime-release.v1") {
    throw new Error("The Runtime release bundle version is unsupported")
  }
  if (!SHA.test(bundle.sourceRevision)) throw new Error("sourceRevision must be a full Git SHA")
  for (const field of ["composeDigest", "runtimeControlDigest", "telemetryConfigDigest"]) {
    if (!DIGEST.test(bundle[field])) throw new Error(`${field} must be a SHA-256 digest`)
  }
  if (!Array.isArray(bundle.images)) throw new Error("images must be an array")
  const images = new Map()
  for (const image of bundle.images) {
    if (
      !object(image) ||
      !IMAGE_NAME.test(image.name) ||
      !IMAGE_REPOSITORY.test(image.repository)
    ) {
      throw new Error("An image entry is invalid")
    }
    if (!DIGEST.test(image.digest) || images.has(image.name)) {
      throw new Error("An image digest or name is invalid")
    }
    images.set(image.name, image)
  }
  for (const name of REQUIRED_IMAGES) {
    if (!images.has(name)) throw new Error(`The ${name} image is required`)
  }
  if (!object(bundle.database) || !Number.isInteger(bundle.database.schemaVersion)) {
    throw new Error("The database compatibility contract is required")
  }
  if (bundle.database.minimumRollbackSchemaVersion > bundle.database.schemaVersion) {
    throw new Error("The rollback schema cannot be newer than the release schema")
  }
  return canonical(bundle)
}

const digestFile = async (path) =>
  `sha256:${createHash("sha256")
    .update(await readFile(path))
    .digest("hex")}`

async function create(path) {
  const sourceRevision = process.env.SOURCE_SHA ?? ""
  const names = REQUIRED_IMAGES
  const images = names.map((name) => ({
    name,
    repository: `ghcr.io/arek-e/bob-${name}`,
    digest: process.env[`${name.toUpperCase().replaceAll("-", "_")}_DIGEST`] ?? ""
  }))
  const runtimeControl = JSON.parse(await readFile("deployment/runtime-control.json", "utf8"))
  const bundle = assertReleaseBundle({
    schemaVersion: "bob.runtime-release.v1",
    sourceRevision,
    composeDigest: await digestFile("deployment/runtime-cluster.compose.yaml"),
    runtimeControlDigest: contentDigest(runtimeControl),
    telemetryConfigDigest: await digestFile("deployment/otel-collector.yaml"),
    images,
    externalImages: runtimeControl.externalImages,
    database: runtimeControl.database
  })
  await writeFile(path, canonicalJson(bundle), { flag: "wx" })
  process.stdout.write(`${contentDigest(bundle)}\n`)
}

const [command, path] = process.argv.slice(2)
if (command === "create" && path) await create(path)
else if (command === "verify" && path) {
  const bundle = assertReleaseBundle(JSON.parse(await readFile(path, "utf8")))
  process.stdout.write(`${JSON.stringify({ digest: contentDigest(bundle), bundle })}\n`)
} else if (process.argv[1]?.endsWith("release-bundle.mjs")) {
  throw new Error("Usage: release-bundle.mjs create|verify PATH")
}
