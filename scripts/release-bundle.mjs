import { createHash } from "node:crypto"
import { readFile, writeFile } from "node:fs/promises"

const SHA_PATTERN = /^[0-9a-f]{40}$/u
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/u
const IMAGE_NAME_PATTERN = /^[a-z][a-z0-9-]{0,62}$/u

const isObject = (value) => Object.prototype.toString.call(value) === "[object Object]"

const canonicalize = (value) => {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (!isObject(value)) return value
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonicalize(item)])
  )
}

export const canonicalReleaseBundle = (bundle) => `${JSON.stringify(canonicalize(bundle))}\n`

export const releaseBundleDigest = (bundle) =>
  `sha256:${createHash("sha256").update(canonicalReleaseBundle(bundle).trimEnd()).digest("hex")}`

export function assertReleaseBundle(bundle) {
  if (!isObject(bundle) || bundle.schemaVersion !== "bob.release.v1") {
    throw new Error("The Runtime release bundle version is unsupported")
  }
  if (!SHA_PATTERN.test(bundle.sourceRevision)) {
    throw new Error("The Runtime release bundle needs one full source revision")
  }
  if (!SHA_PATTERN.test(bundle.configurationRevision)) {
    throw new Error("The Runtime release bundle needs one full configuration revision")
  }
  if (!DIGEST_PATTERN.test(bundle.deploymentContractDigest)) {
    throw new Error("The Runtime release bundle needs a deployment contract digest")
  }
  const expectedContractUri = `https://raw.githubusercontent.com/arek-e/bob/${bundle.configurationRevision}/deployment-contract.json`
  if (bundle.deploymentContractUri !== expectedContractUri) {
    throw new Error("The deployment contract URI does not match the configuration revision")
  }
  if (
    !Array.isArray(bundle.runtimeImages) ||
    bundle.runtimeImages.length === 0 ||
    bundle.runtimeImages.length > 32 ||
    bundle.runtimeImages.some(
      (image) =>
        !isObject(image) ||
        !IMAGE_NAME_PATTERN.test(image.name) ||
        !DIGEST_PATTERN.test(image.digest)
    ) ||
    new Set(bundle.runtimeImages.map((image) => image.name)).size !== bundle.runtimeImages.length
  ) {
    throw new Error("The Runtime release bundle image manifest is invalid")
  }
  const images = new Map(bundle.runtimeImages.map((image) => [image.name, image.digest]))
  if (images.get("agent") !== bundle.agentImageDigest) {
    throw new Error("The agent image does not match the Runtime image manifest")
  }
  if (images.get("backup") !== bundle.backupImageDigest) {
    throw new Error("The backup image does not match the Runtime image manifest")
  }
  return bundle
}

export function makeReleaseBundle(input) {
  return assertReleaseBundle({
    schemaVersion: "bob.release.v1",
    sourceRevision: input.sourceRevision,
    configurationRevision: input.configurationRevision,
    deploymentContractDigest: input.deploymentContractDigest,
    deploymentContractUri: input.deploymentContractUri,
    runtimeImages: [...input.runtimeImages].sort((left, right) =>
      left.name.localeCompare(right.name)
    ),
    agentImageDigest: input.agentImageDigest,
    backupImageDigest: input.backupImageDigest
  })
}

export async function readReleaseBundle(path) {
  return assertReleaseBundle(JSON.parse(await readFile(path, "utf8")))
}

const main = async () => {
  const [command, path] = process.argv.slice(2)
  if (command === "verify" && path) {
    const bundle = await readReleaseBundle(path)
    process.stdout.write(`${JSON.stringify({ bundle, digest: releaseBundleDigest(bundle) })}\n`)
    return
  }
  if (command !== "create" || !path) {
    throw new Error("Usage: release-bundle.mjs create|verify PATH")
  }
  const sourceRevision = process.env.SOURCE_SHA ?? ""
  const agentImageDigest = process.env.AGENT_DIGEST ?? ""
  const backupImageDigest = process.env.BACKUP_DIGEST ?? ""
  const [baseImages, deploymentContract] = await Promise.all([
    readFile("infra/coolify/base-images.json", "utf8").then(JSON.parse),
    readFile("deployment-contract.json", "utf8").then(JSON.parse)
  ])
  if (baseImages.schemaVersion !== 1) {
    throw new Error("The Runtime base image manifest version is unsupported")
  }
  const deploymentContractDigest = `sha256:${createHash("sha256")
    .update(JSON.stringify(canonicalize(deploymentContract)))
    .digest("hex")}`
  const bundle = makeReleaseBundle({
    sourceRevision,
    configurationRevision: sourceRevision,
    deploymentContractDigest,
    deploymentContractUri: `https://raw.githubusercontent.com/arek-e/bob/${sourceRevision}/deployment-contract.json`,
    runtimeImages: [
      { name: "agent", digest: agentImageDigest },
      { name: "backup", digest: backupImageDigest },
      { name: "cloudflared", digest: baseImages.cloudflaredDigest },
      { name: "observer", digest: baseImages.observerDigest }
    ],
    agentImageDigest,
    backupImageDigest
  })
  await writeFile(path, canonicalReleaseBundle(bundle), { flag: "wx" })
  process.stdout.write(`${releaseBundleDigest(bundle)}\n`)
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  await main()
}
