import { execFileSync } from "node:child_process"
import { pathToFileURL } from "node:url"

const COMMIT_PATTERN = /^[a-f0-9]{40}$/u
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/u
const RELEASE_PATH = "infra/coolify/release.json"

function parseManifest(value) {
  const manifest = JSON.parse(value)
  if (
    manifest.schemaVersion !== 1 ||
    !COMMIT_PATTERN.test(manifest.sourceSha) ||
    !DIGEST_PATTERN.test(manifest.agentDigest) ||
    !DIGEST_PATTERN.test(manifest.backupDigest)
  ) {
    throw new Error("The Coolify release manifest is invalid")
  }
  return manifest
}

export function assertReleaseManifestDelta({ sourceManifest, deploymentManifest, sourceSha }) {
  if (!COMMIT_PATTERN.test(sourceSha)) throw new Error("The source SHA must be a full commit")
  const source = parseManifest(sourceManifest)
  const deployment = parseManifest(deploymentManifest)
  if (deployment.sourceSha !== sourceSha || deployment.sourceSha === source.sourceSha) {
    throw new Error("The deployment source SHA must equal the reviewed source SHA")
  }
  if (deployment.agentDigest === source.agentDigest) {
    throw new Error("The deployment commit must change the agent digest")
  }
  if (deployment.backupDigest === source.backupDigest) {
    throw new Error("The deployment commit must change the backup digest")
  }
  const normalizedSource = {
    ...source,
    sourceSha: "<SOURCE_SHA>",
    agentDigest: "<AGENT>",
    backupDigest: "<BACKUP>"
  }
  const normalizedDeployment = {
    ...deployment,
    sourceSha: "<SOURCE_SHA>",
    agentDigest: "<AGENT>",
    backupDigest: "<BACKUP>"
  }
  if (JSON.stringify(normalizedSource) !== JSON.stringify(normalizedDeployment)) {
    throw new Error("The deployment commit changes content outside the three release values")
  }
  return {
    agentDigest: deployment.agentDigest,
    backupDigest: deployment.backupDigest,
    releaseSha: deployment.sourceSha
  }
}

function gitFile(commit) {
  try {
    return execFileSync("git", ["show", `${commit}:${RELEASE_PATH}`], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    })
  } catch {
    throw new Error("Could not read the Coolify release manifest from the reviewed commit")
  }
}

export function verifyReleaseManifestDelta(sourceSha, deploymentSha) {
  if (!COMMIT_PATTERN.test(sourceSha) || !COMMIT_PATTERN.test(deploymentSha)) {
    throw new Error("Both release inputs must be full commits")
  }
  return assertReleaseManifestDelta({
    sourceManifest: gitFile(sourceSha),
    deploymentManifest: gitFile(deploymentSha),
    sourceSha
  })
}

const invokedPath = process.argv[1]
if (invokedPath !== undefined && import.meta.url === pathToFileURL(invokedPath).href) {
  const sourceSha = process.argv[2]
  const deploymentSha = process.argv[3]
  if (sourceSha === undefined || deploymentSha === undefined) {
    throw new Error("Usage: verify-release-manifest-delta.mjs SOURCE_SHA DEPLOYMENT_SHA")
  }
  process.stdout.write(`${JSON.stringify(verifyReleaseManifestDelta(sourceSha, deploymentSha))}\n`)
}
